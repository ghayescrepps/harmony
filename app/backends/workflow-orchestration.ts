import _, { ceil, range } from 'lodash';
import { NextFunction, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { Logger } from 'winston';
import db, { batchSize, Transaction } from '../util/db';
import { completeJob } from '../util/job';
import env from '../util/env';
import { readCatalogItems, StacItemLink } from '../util/stac';
import HarmonyRequest from '../models/harmony-request';
import { Job, JobStatus } from '../models/job';
import JobLink, { getJobDataLinkCount } from '../models/job-link';
import WorkItem, { updateWorkItemStatus, getWorkItemById, workItemCountForStep, getWorkItemsByJobIdAndStepIndex, getJobIdForWorkItem, getNextWorkItem } from '../models/work-item';
import WorkflowStep, { decrementFutureWorkItemCount, getWorkflowStepByJobIdStepIndex, getWorkflowStepsByJobId } from '../models/workflow-steps';
import { objectStoreForProtocol } from '../util/object-store';
import { resolve } from '../util/url';
import { ServiceError } from '../util/errors';
import { COMPLETED_WORK_ITEM_STATUSES, WorkItemStatus } from '../models/work-item-interface';
import JobError, { getErrorCountForJob } from '../models/job-error';
import WorkItemUpdate from '../models/work-item-update';

const MAX_TRY_COUNT = 1;
const RETRY_DELAY = 1000 * 120;
const QUERY_CMR_SERVICE_REGEX = /harmonyservices\/query-cmr:.*/;

/**
 * Calculate the granule page limit for the current query-cmr work item.
 * @param tx - database transaction to query with
 * @param workItem - current query-cmr work item
 * @param logger - a Logger instance
 * @returns a number used to limit the query-cmr task or undefined
 */
async function calculateQueryCmrLimit(tx: Transaction, workItem: WorkItem, logger: Logger): Promise<number> {
  let queryCmrLimit = -1;
  if (workItem && QUERY_CMR_SERVICE_REGEX.test(workItem.serviceID)) { // only proceed if this is a query-cmr step
    const numInputGranules = await Job.getNumInputGranules(tx, workItem.jobID);
    const numSuccessfulQueryCmrItems = await workItemCountForStep(tx, workItem.jobID, 1, WorkItemStatus.SUCCESSFUL);
    queryCmrLimit = Math.max(0, Math.min(env.cmrMaxPageSize, numInputGranules - (numSuccessfulQueryCmrItems * env.cmrMaxPageSize)));
    logger.debug(`Limit next query-cmr task to no more than ${queryCmrLimit} granules.`);
  }
  return queryCmrLimit;
}

/**
 * Return a work item for the given service
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns Resolves when the request is complete
 */
export async function getWork(
  req: HarmonyRequest, res: Response, next: NextFunction, tryCount = 1,
): Promise<void> {
  const { logger } = req.context;
  const { serviceID, podName } = req.query;

  let workItem: WorkItem, maxCmrGranules: number;

  await db.transaction(async (tx) => {
    workItem = await getNextWorkItem(tx, serviceID as string);
    if (workItem) {
      logger.debug(`Sending work item ${workItem.id} to pod ${podName}`);
      if (workItem && QUERY_CMR_SERVICE_REGEX.test(workItem.serviceID)){
        maxCmrGranules = await calculateQueryCmrLimit(tx, workItem, logger);
        res.send({ workItem, maxCmrGranules });
      } else {
        res.send({ workItem });
      }
    } else if (tryCount < MAX_TRY_COUNT) {
      setTimeout(async () => {
        await getWork(req, res, next, tryCount + 1);
      }, RETRY_DELAY);
    } else {
      res.status(404).send();
    }
  });
}

/**
 * Add links to the Job for the WorkItem and save them to the database.
 *
 * @param tx - The database transaction
 * @param job - The job for the work item
 * @param results  - an array of paths to STAC catalogs
 * @param logger - The logger for the request
 */
async function addJobLinksForFinishedWorkItem(
  tx: Transaction,
  job: Job,
  results: string[],
  logger: Logger,
): Promise<void> {
  for (const catalogLocation of results) {
    logger.debug(`Adding link for STAC catalog ${catalogLocation}`);

    const items = await readCatalogItems(catalogLocation);

    for await (const item of items) {
      for (const keyValue of Object.entries(item.assets)) {
        const asset = keyValue[1];
        const { href, type, title } = asset;
        const link = new JobLink({
          jobID: job.jobID,
          href,
          type,
          title,
          rel: 'data',
          temporal: {
            start: new Date(item.properties.start_datetime),
            end: new Date(item.properties.end_datetime),
          },
          bbox: item.bbox,
        });
        await link.save(tx);
      }
    }
  }
}

/**
 * Read a STAC catalog and return the item links. This does not handle sub-catalogs. This function
 * makes assumptions based on the Harmony STAC directory layout for services inputs/outputs and
 * is only intended to be used when aggregating service outputs into a single catalog.
 * @param catalogPath - the path to the catalog
 */
async function getItemLinksFromCatalog(catalogPath: string): Promise<StacItemLink[]> {
  const s3 = objectStoreForProtocol('s3');
  const catalog = await s3.getObjectJson(catalogPath);
  const links: StacItemLink[] = [];
  for (const link of catalog.links) {
    if (link.rel === 'item') {
      // make relative path absolute
      const { href } = link;
      link.href = resolve(catalogPath, href);
      links.push(link);
    }
  }

  return links;
}

/**
 * Creates a work item that uses all the output of the previous step. This function assumes that
 * all work items for the previous step are completed. It also relies on the convention that
 * services write out their results as STAC catalogs with the following path
 * `/tmp/<JOB_ID>/<WORK_ITEM_ID>/outputs/catalog.json`
 *                       OR
 * `/tmp/<JOB_ID>/<WORK_ITEM_ID>/outputs/catalogN.json` (when a step can generate multiple outputs)
 * where N is from 0 to the number of results - 1.
 *
 * @param tx - The database transaction
 * @param currentWorkItem - The current work item
 * @param nextStep - the next step in the workflow
 * @param results - an array of paths to STAC catalogs from the last worked item
 */
async function createAggregatingWorkItem(
  tx: Transaction, currentWorkItem: WorkItem, nextStep: WorkflowStep,
): Promise<void> {
  const itemLinks: StacItemLink[] = [];
  const s3 = objectStoreForProtocol('s3');
  // get all the previous results
  const workItemCount = await workItemCountForStep(tx, currentWorkItem.jobID, nextStep.stepIndex - 1);
  let page = 1;
  let processedItemCount = 0;
  while (processedItemCount < workItemCount) {
    const prevStepWorkItems = await getWorkItemsByJobIdAndStepIndex(tx, currentWorkItem.jobID, nextStep.stepIndex - 1, page);
    // guard against failure case where we cannot retrieve all items - THIS SHOULD NEVER HAPPEN
    if (prevStepWorkItems.workItems.length < 1) break;

    for (const workItem of prevStepWorkItems.workItems) {
      try {
        // try to use the default catalog output for single granule work items
        const singleCatalogPath = workItem.getStacLocation('catalog.json');
        const newLinks = await getItemLinksFromCatalog(singleCatalogPath);
        itemLinks.push(...newLinks);
      } catch {
        // couldn't read the single catalog so read the JSON file that lists all the result
        // catalogs for this work item
        const jsonPath = workItem.getStacLocation('batch-catalogs.json');
        const catalog = await s3.getObjectJson(jsonPath);
        const linksPromises: Promise<StacItemLink[]>[] = catalog.map((filename: string) => {
          const fullPath = workItem.getStacLocation(filename);
          return getItemLinksFromCatalog(fullPath);
        });
        const linksListList: StacItemLink[][] = await Promise.all(linksPromises);
        for (const linksList of linksListList) {
          itemLinks.push(...linksList);
        }
      }
      processedItemCount++;
    }
    page++;
  }

  // if we could not pull back all the work items we expected then something went wrong
  if (processedItemCount < workItemCount) {
    throw new ServiceError(500, `Failed to retrieve all work items for step ${nextStep.stepIndex - 1}`);
  }

  const pageSize = env.aggregateStacCatalogMaxPageSize;
  const catalogCount = ceil(itemLinks.length / env.aggregateStacCatalogMaxPageSize);
  for (const index of range(0, catalogCount)) {
    const start = index * pageSize;
    const end = start + pageSize;
    const links = itemLinks.slice(start, end);

    // and prev/next links as needed
    if (index > 0) {
      const prevCatUrl = currentWorkItem.getStacLocation(`catalog${index - 1}.json`, true);
      const prevLink: StacItemLink = {
        href: prevCatUrl,
        rel: 'prev',
        title: 'Previous page',
        type: 'application/json',
      };
      links.push(prevLink);
    }

    if (index < catalogCount - 1) {
      const nextCatUrl = currentWorkItem.getStacLocation(`catalog${index + 1}.json`, true);
      const nextLink: StacItemLink = {
        href: nextCatUrl,
        rel: 'next',
        title: 'Next page',
        type: 'application/json',
      };
      links.push(nextLink);
    }

    // create a STAC catalog with links
    const catalog = {
      stac_version: '1.0.0-beta.2',
      stac_extensions: [],
      id: uuid(),
      description: 'Aggregation input catalogs',
      links: links,
    };

    const catalogJson = JSON.stringify(catalog, null, 4);

    // write the new catalog out to s3
    const catalogPath = currentWorkItem.getStacLocation(`catalog${index}.json`, true);
    await s3.upload(catalogJson, catalogPath, null, 'application/json');
  }

  // catalog0 is the first catalog in the linked catalogs, so it is the catalog
  // that aggregating services should read first
  const podCatalogPath = currentWorkItem.getStacLocation('catalog0.json', true);

  const newWorkItem = new WorkItem({
    jobID: currentWorkItem.jobID,
    serviceID: nextStep.serviceID,
    status: WorkItemStatus.READY,
    stacCatalogLocation: podCatalogPath,
    workflowStepIndex: nextStep.stepIndex,
  });

  await newWorkItem.save(tx);
}

/**
 * Creates the next work items for the workflow based on the results of the current step
 * @param tx - The database transaction
 * @param currentWorkItem - The current work item
 * @param nextStep - the next step in the workflow
 * @param results - an array of paths to STAC catalogs
 */
async function createNextWorkItems(
  tx: Transaction, workItem: WorkItem, allWorkItemsForStepComplete: boolean, results: string[],
): Promise<WorkflowStep> {
  const nextStep = await getWorkflowStepByJobIdStepIndex(
    tx, workItem.jobID, workItem.workflowStepIndex + 1,
  );

  if (nextStep) {
    if (results && results.length > 0) {
      // if we have completed all the work items for this step or if the next step does not
      // aggregate then create a work item for the next step
      if (nextStep.hasAggregatedOutput) {
        if (allWorkItemsForStepComplete) {
          await createAggregatingWorkItem(tx, workItem, nextStep);
        }
      } else {
        // Create a new work item for each result using the next step
        const newItems = results.map(result =>
          new WorkItem({
            jobID: workItem.jobID,
            serviceID: nextStep.serviceID,
            status: WorkItemStatus.READY,
            stacCatalogLocation: result,
            workflowStepIndex: nextStep.stepIndex,
          }),
        );
        for (const batch of _.chunk(newItems, batchSize)) {
          await WorkItem.insertBatch(tx, batch);
        }
      }
    }
  }
  return nextStep;
}

/**
 * Creates another next query-cmr work item if needed
 * @param tx - The database transaction
 * @param currentWorkItem - The current work item
 * @param nextStep - the next step in the workflow
 */
async function maybeQueueQueryCmrWorkItem(
  tx: Transaction, currentWorkItem: WorkItem, logger: Logger,
): Promise<void> {
  if (QUERY_CMR_SERVICE_REGEX.test(currentWorkItem.serviceID)) {
    if (await calculateQueryCmrLimit(tx, currentWorkItem, logger) > 0) {
      const nextQueryCmrItem = new WorkItem({
        jobID: currentWorkItem.jobID,
        scrollID: currentWorkItem.scrollID,
        serviceID: currentWorkItem.serviceID,
        status: WorkItemStatus.READY,
        stacCatalogLocation: currentWorkItem.stacCatalogLocation,
        workflowStepIndex: currentWorkItem.workflowStepIndex,
      });

      await nextQueryCmrItem.save(tx);
    }
  }
}

/**
 * If a work item has an error adds the error to the job_errors database table.
 *
 * @param tx - The database transaction
 * @param job - The job record
 * @param url - The URL to include in the error
 * @param message - An error message to include in the error
 */
async function addErrorForWorkItem(
  tx: Transaction, job: Job, url: string, message: string,
): Promise<void> {
  const error = new JobError({
    jobID: job.jobID,
    url,
    message,
  });
  await error.save(tx);
}

/**
 * Returns the final job status for the request based on whether all items were
 * successful, some were successful and some failed, or all items failed.
 *
 * @param tx - The database transaction
 * @param job - The job record
 * @returns the final job status for the request
 */
async function getFinalStatusForJob(tx: Transaction, job: Job): Promise<JobStatus> {
  let finalStatus = JobStatus.SUCCESSFUL;
  if (await getErrorCountForJob(tx, job.jobID) > 0) {
    if (await getJobDataLinkCount(tx, job.jobID) > 0) {
      finalStatus = JobStatus.COMPLETE_WITH_ERRORS;
    } else {
      finalStatus = JobStatus.FAILED;
    }
  }
  return finalStatus;
}

/**
 * Returns a URL for the work item which will be stored with a job error.
 *
 * @param workItem - The work item
 * @param logger - The logger for the request
 *
 * @returns a relevant URL for the work item that failed if a data URL exists
 */
async function getWorkItemUrl(workItem, logger): Promise<string> {
  let url = 'unknown';
  if (workItem.stacCatalogLocation) {
    try {
      const items = await readCatalogItems(workItem.stacCatalogLocation);
      // Only consider the first item in the list
      url = items[0].assets.data.href;
    } catch (e) {
      logger.error(`Could not read catalog for ${workItem.stacCatalogLocation}`);
      logger.error(e);
    }
  }

  return url;
}

/**
 * Checks if the work item failed and if so handles the logic of determining whether to
 * fail the job or continue to processing. If there's an error it adds it to the job_errors
 * table.
 *
 * @param tx - The database transaction
 * @param job - The job associated with the work item
 * @param workItem - The work item that just finished
 * @param workflowStep - The current workflow step
 * @param status - The status sent with the work item update
 * @param errorMessage - The error message associated with the work item update (if any)
 * @param logger - The logger for the request
 *
 * @returns whether to continue processing work item updates or end
 */
async function handleFailedWorkItems(
  tx: Transaction, job: Job, workItem: WorkItem, workflowStep: WorkflowStep, status: WorkItemStatus,
  logger: Logger, errorMessage: string,
): Promise<boolean> {
  let continueProcessing = true;
  // If the response is an error then set the job status to 'failed'
  if (status === WorkItemStatus.FAILED) {
    continueProcessing = job.ignoreErrors;
    if (!job.isComplete()) {
      let jobMessage;

      if (errorMessage) {
        jobMessage = `WorkItem [${workItem.id}] failed with error: ${errorMessage}`;
      }

      if (QUERY_CMR_SERVICE_REGEX.test(workItem.serviceID)) {
        // Fail the request if query-cmr fails to populate granules
        continueProcessing = false;
        if (!jobMessage) {
          jobMessage = `WorkItem [${workItem.id}] failed to query CMR for granule information`;
        }
      } else {
        const url = await getWorkItemUrl(workItem, logger);
        if (!jobMessage) {
          jobMessage = `WorkItem [${workItem.id}] failed with an unknown error`;
        }
        await addErrorForWorkItem(tx, job, url, jobMessage);
      }

      if (continueProcessing) {
        const errorCount =  await getErrorCountForJob(tx, job.jobID);
        if (errorCount > env.maxErrorsForJob) {
          jobMessage = `Maximum allowed errors ${env.maxErrorsForJob} exceeded`;
          continueProcessing = false;
        }
      }

      if (!continueProcessing) {
        await completeJob(tx, job, JobStatus.FAILED, logger, jobMessage);
      } else {
        // Need to make sure we expect one fewer granule to complete
        await decrementFutureWorkItemCount(tx, job.jobID, workflowStep.stepIndex);
        if (job.status == JobStatus.RUNNING) {
          job.status = JobStatus.RUNNING_WITH_ERRORS;
          await job.save(tx);
        }
      }
    }
  }
  return continueProcessing;
}

/**
 * Updated the workflow steps `workItemCount` field for the given job to match the new
 *
 * @param transaction - the transaction to use for the update
 * @param job - A Job that has a new input granule count
 */
async function updateWorkItemCounts(
  transaction: Transaction,
  job: Job):
  Promise<void> {
  const workflowSteps = await getWorkflowStepsByJobId(transaction, job.jobID);
  for (const step of workflowSteps) {
    if (QUERY_CMR_SERVICE_REGEX.test(step.serviceID)) {
      step.workItemCount = Math.ceil(job.numInputGranules / env.cmrMaxPageSize);
    } else if (!step.hasAggregatedOutput) {
      step.workItemCount = job.numInputGranules;
    } else {
      step.workItemCount = 1;
    }
    await step.save(transaction);
  }
}

/**
 * Update job status/progress in response to a service provided work item update
 *
 * @param update - information about the work item update
 */
export async function handleWorkItemUpdate(update: WorkItemUpdate, logger: Logger): Promise<void> {
  const { workItemID, status, hits, results, scrollID, errorMessage, totalGranulesSize } = update;
  if (status === WorkItemStatus.SUCCESSFUL) {
    logger.info(`Updating work item ${workItemID} to ${status}`);
  }
  // get the jobID for the work item
  const jobID = await getJobIdForWorkItem(workItemID);

  await db.transaction(async (tx) => {
    const job = await Job.byJobID(tx, jobID, false, true);
    // lock the work item to we can update it - need to do this after locking jobs table above
    // to avoid deadlocks
    const workItem = await getWorkItemById(tx, workItemID, true);
    const thisStep = await getWorkflowStepByJobIdStepIndex(tx, workItem.jobID, workItem.workflowStepIndex);

    // If the job was already in a terminal state then send 409 response
    // unless we are just canceling the work item
    if (job.isComplete() && status !== WorkItemStatus.CANCELED) {
      logger.warn(`Job was already ${job.status}.`);
      // Note work item will stay in the running state, but the reaper will clean it up
      return;
    }

    // Don't allow updates to work items that are already in a terminal state
    if (COMPLETED_WORK_ITEM_STATUSES.includes(workItem.status)) {
      logger.warn(`WorkItem ${workItemID} was already ${workItem.status}`);
      return;
    }

    // retry failed work-items up to a limit
    if (status === WorkItemStatus.FAILED) {
      if (workItem.retryCount < env.workItemRetryLimit) {
        logger.warn(`Retrying failed work-item ${workItemID}`);
        workItem.retryCount += 1;
        workItem.status = WorkItemStatus.READY;
        await workItem.save(tx);
        return;
      } else {
        logger.warn(`Retry limit of ${env.workItemRetryLimit} exceeded`);
        logger.warn(`Updating work item for ${workItemID} to ${status} with message ${errorMessage}`);
      }
    }

    // We calculate the duration of the work both in harmony and in the manager of the service pod.
    // We tend to favor the harmony value as it is normally longer since it accounts for the extra
    // overhead of communication with the pod. There is a problem with retries however in that 
    // the startTime gets reset, so if an earlier worker finishes and replies it will look like
    // the whole thing was quicker (since our startTime has changed). So in that case we want to 
    // use the time reported by the service pod. Any updates from retries that happen later  will
    // be ignored since the work item is already in a 'successful' state.
    const harmonyDuration = Date.now() - workItem.startedAt.valueOf();
    let duration = harmonyDuration;
    if (update.duration) {
      duration = Math.max(duration, update.duration);
    }

    logger.debug(`Work item duration (ms): ${duration}`);

    await updateWorkItemStatus(tx, workItemID, status as WorkItemStatus, duration, totalGranulesSize);

    const completedWorkItemCount = await workItemCountForStep(
      tx, workItem.jobID, workItem.workflowStepIndex, COMPLETED_WORK_ITEM_STATUSES,
    );
    const allWorkItemsForStepComplete = (completedWorkItemCount == thisStep.workItemCount);

    if (hits && job.numInputGranules > hits) {
      job.numInputGranules = hits;
      await job.save(tx);
      await updateWorkItemCounts(tx, job);
    }

    const continueProcessing = await handleFailedWorkItems(tx, job, workItem, thisStep, status, logger, errorMessage);
    if (continueProcessing) {
      let nextStep = null;
      if (status != WorkItemStatus.FAILED) {
        nextStep = await createNextWorkItems(tx, workItem, allWorkItemsForStepComplete, results);
      }

      if (nextStep) {
        if (results && results.length > 0) {
          // set the scrollID for the next work item to the one we received from the update
          workItem.scrollID = scrollID;
          await maybeQueueQueryCmrWorkItem(tx, workItem, logger);
        } else {
          // Failed to create the next work items - fail the job rather than leaving it orphaned
          // in the running state
          logger.error('The work item update should have contained results to queue a next work item, but it did not.');
          const message = 'Harmony internal failure: could not create the next work items for the request.';
          await completeJob(tx, job, JobStatus.FAILED, logger, message);
        }
      } else {
        // Finished with the chain for this granule
        if (status != WorkItemStatus.FAILED) {
          await addJobLinksForFinishedWorkItem(tx, job, results, logger);
        }
        // If all granules are finished mark the job as finished
        job.completeBatch(thisStep.workItemCount);
        if (allWorkItemsForStepComplete) {
          const finalStatus = await getFinalStatusForJob(tx, job);
          await completeJob(tx, job, finalStatus, logger);
        } else {
          // Special case to pause the job as soon as any single granule completes when in the previewing state
          if (job.status === JobStatus.PREVIEWING) {
            job.pause();
          }
          await job.save(tx);
        }
      }
    }
  });
}

/**
 * Update a work item from a service response. This function stores the update without further
 * processing and then responds quickly. Processing the update is handled asynchronously
 * (see `handleWorkItemUpdate`)
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @returns Resolves when the request is complete
 */
export async function updateWorkItem(req: HarmonyRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const { status, hits, results, scrollID, errorMessage, duration } = req.body;
  const totalGranulesSize = req.body.totalGranulesSize ? parseFloat(req.body.totalGranulesSize) : 0;

  const update =
  {
    workItemID: parseInt(id),
    status,
    hits,
    results,
    scrollID,
    errorMessage,
    totalGranulesSize,
    duration,
  };

  // asynchronously handle the update so that the service is not waiting for a response
  // during a potentially long update. If the asynchronous update fails the work-item will
  // eventually be retried by the timeout handler. In any case there is not much the service
  // can do if the update fails, so it is OK for us to ignore the promise here. The service
  // can still retry for network or similar failures, but we don't want it to retry for things
  // like 409 errors.
  if (db.client.config.client === 'pg') {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    handleWorkItemUpdate(update, req.context.logger);
  } else {
    // tests break if we don't await this
    await handleWorkItemUpdate(update, req.context.logger);
  }

  // Return a success with no body
  res.status(204).send();
}
