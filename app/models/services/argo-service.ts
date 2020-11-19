import _ from 'lodash';
import { Logger } from 'winston';
import * as axios from 'axios';
import BaseService, { functionalSerializeOperation } from './base-service';
import InvocationResult from './invocation-result';

import env = require('../../util/env');

export interface ArgoServiceParams {
  argo_url: string;
  namespace: string;
  template: string;
  template_type?: string;
  template_ref?: string;
  embedded_template?: string;
  image_pull_policy?: string;
  parallelism?: number;
  postBatchStepCount?: number;
  env: { [key: string]: string };
  image?: string;
}

export interface ServiceImage {
  name: string;
  image: string;
}

interface ArgoVariable {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: {
      name: string;
      key: string;
    };
  };
}

/**
 * Service implementation which invokes an Argo workflow and creates a Job to poll for service
 * updates.
 * @class ArgoService
 * @extends {BaseService}
 */
export default class ArgoService extends BaseService<ArgoServiceParams> {
  /**
   * Returns the batch size to use for the given request
   * @private
   *
   * @param maxGranules The system-wide maximum granules
   * @returns The number of granules per batch of results processed
   */
  chooseBatchSize(maxGranules = env.maxGranuleLimit): number {
    const { maxResults } = this.operation;

    let batchSize = _.get(this.config, 'batch_size', env.defaultBatchSize);

    if (batchSize <= 0 || batchSize > maxGranules) {
      batchSize = maxGranules;
    }

    if (maxResults) {
      batchSize = Math.min(batchSize, maxResults);
    }

    return batchSize;
  }

  /**
   * Returns the page size to use for the given request
   * @private
   *
   * @param maxGranules The system-wide maximum granules
   * @returns The number of granules per page of results from the CMR
   */
  choosePageSize(maxGranules = env.maxGranuleLimit): number {
    const { maxResults } = this.operation;
    // TODO create an env var for this based on CMR max page size
    let pageSize = 2000;

    if (pageSize > maxGranules) {
      pageSize = maxGranules;
    }

    if (maxResults) {
      pageSize = Math.min(pageSize, maxResults);
    }

    return pageSize;
  }

  /**
   * Invokes an Argo workflow to execute a service request
   *
   *  @param logger the logger associated with the request
   *  @returns A promise resolving to null
   */
  async _run(logger: Logger): Promise<InvocationResult> {
    const url = `${this.params.argo_url}/api/v1/workflows/${this.params.namespace}`;

    const goodVars = _.reject(Object.keys(this.params.env),
      (variable) => _.includes(['OAUTH_UID', 'OAUTH_PASSWORD', 'EDL_USERNAME', 'EDL_PASSWORD'], variable));
    const dockerEnv = _.map(goodVars,
      (variable) => ({ name: variable, value: this.params.env[variable] }));

    // similarly we need to get at the model for the operation to retrieve parameters needed to
    // construct the workflow
    const serializedOperation = this.serializeOperation();
    const operation = JSON.parse(serializedOperation);

    // const resultHandlerScript =
    // resultHandlerScriptTemplate.replace('{{inputs.parameters.batch-count}}', '{batch.length}');

    let params = [
      {
        name: 'callback',
        value: operation.callback,
      },
      {
        name: 'cmr-granule-locator-image',
        value: env.cmrGranuleLocatorImage,
      },
      {
        name: 'image-pull-policy',
        value: this.params.image_pull_policy || env.defaultImagePullPolicy,
      },
      {
        name: 'timeout',
        value: `${env.defaultArgoPodTimeoutSecs}`, // Could use request specific value in the future
      },
      {
        name: 'post-batch-step-count',
        value: `${this.params.postBatchStepCount || 0}`,
      },
      {
        name: 'page-size',
        value: `${this.chooseBatchSize()}`,
      },
      {
        name: 'batch-size',
        value: `${this.choosePageSize()}`,
      },
      {
        name: 'parallelism',
        value: this.params.parallelism || env.defaultParallelism,
      },
      {
        name: 'query',
        value: this.operation.cmrQueryLocations.join(' '),
      },
    ];

    params = params.concat(dockerEnv);

    const templateType = this.params.template_type || 'legacy';
    const body = templateType === 'chaining' ? this._chainedWorkflowBody(params) : this._legacyWorkflowBody(params);

    try {
      await axios.default.post(url, body);
    } catch (e) {
      logger.error(`Argo workflow creation failed: ${JSON.stringify(e.response?.data)}`);
      logger.error(`Argo url: ${url}`);
      logger.error(`Workflow body: ${JSON.stringify(body)}`);
      throw e;
    }

    return null;
  }

  _buildExitHandlerScript(): string {
    return `
    echo '{{workflow.failures}}' > /tmp/failures
    error="{{workflow.status}}"
    timeout_count=$(grep -c 'Pod was active on the node longer than the specified deadline' /tmp/failures)
    if [ "$timeout_count" != "0" ]
    then
    error="Request%20timed%20out"
    fi
    if [ "{{workflow.status}}" == "Succeeded" ]
    then
    curl -XPOST "{{inputs.parameters.callback}}/response?status=successful&argo=true"
    else
    curl -XPOST "{{inputs.parameters.callback}}/response?status=failed&argo=true&error=$error"
    fi
    `.trim();
  }

  /**
   * Returns a workflow POST body for Argo for invoking chainable services
   * @param params The common workflow parameters to be passed to each service
   * @returns a JSON-serializable object to be POST-ed to initiate the Argo workflows
   */
  _chainedWorkflowBody(params: ArgoVariable[]): unknown {
    const { user, requestId } = this.operation;
    const serviceEnv = this.params.env;
    const envKeys = Object.keys(serviceEnv);
    const argoEnv: ArgoVariable[] = envKeys.map((k) => ({ name: k, value: serviceEnv[k] }));
    argoEnv.push({
      name: 'SHARED_SECRET_KEY',
      valueFrom: { secretKeyRef: { name: 'shared-secret', key: 'secret-key' } },
    });

    const serializedOperation = JSON.parse(this.serializeOperation());
    for (const source of serializedOperation.sources) {
      delete source.granules;
    }

    // TODO: HARMONY-559: Complete and move to permanent home.  For now, calls CMR and echoes result
    return {
      namespace: this.params.namespace,
      serverDryRun: false,
      workflow: {
        metadata: {
          generateName: `${this.config.name.replace('/', '-')}-`,
          namespace: this.params.namespace,
          labels: {
            user,
            request_id: requestId,
          },
        },
        spec: {
          entryPoint: 'service',
          onExit: 'exit-handler',
          templates: [
            {
              name: 'service',
              steps: [
                [{
                  name: 'query-granules',
                  template: 'query',
                }],
                [{
                  name: 'print-files',
                  template: 'print',
                  arguments: {
                    artifacts: [{
                      name: 'files',
                      from: '{{steps.query-granules.outputs.artifacts.granules}}',
                    }],
                  },
                }],
              ],
            },
            {
              name: 'query',
              podSpecPatch: `{"activeDeadlineSeconds":${env.defaultArgoPodTimeoutSecs}}`,
              container: {
                image: `${env.builtInTaskPrefix}harmony/query-cmr:${env.builtInTaskVersion}`,
                imagePullPolicy: this.params.image_pull_policy || env.defaultImagePullPolicy,
                args: [
                  '--harmony-input',
                  JSON.stringify(serializedOperation),
                  '--query',
                  ...this.operation.cmrQueryLocations,
                  '--output-dir',
                  '/tmp/outputs',
                  '--page-size',
                  `${this.chooseBatchSize()}`,
                  // Hard-coded to run only a single page until the no granule limit epic
                  '--max-pages',
                  '1',
                ],
                env: argoEnv.concat({ name: 'CMR_ENDPOINT', value: env.cmrEndpoint }),
              },
              outputs: {
                artifacts: [{ name: 'granules', path: '/tmp/outputs' }],
              },
            },
            {
              name: 'print',
              inputs: { artifacts: [{ name: 'files', path: '/tmp/files' }] },
              container: {
                image: 'alpine:latest',
                command: ['sh', '-c'],
                args: ['find /tmp/files -type f -exec cat {} \\;'],
              },
            },
            {
              name: 'exit-handler',
              inputs: {
                parameters: params,
              },
              script: {
                image: 'curlimages/curl',
                command: ['sh'],
                source: this._buildExitHandlerScript(),
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Returns a workflow POST body for Argo for invoking legacy (non-chained, low-granule limit)
   * services
   * @param params The common workflow parameters to be passed to each service
   * @returns a JSON-serializable object to be POST-ed to initiate the Argo workflows
   */
  _legacyWorkflowBody(params: ArgoVariable[]): unknown {
    const { user, requestId } = this.operation;

    // we need to serialize the batch operation to get just the model and then deserialize
    // it so we can pass it to the Argo looping/concurrency mechanism in the workflow
    // which expects objects not strings
    const serializedOp = functionalSerializeOperation(this.operation, this.config);

    const serializedOperation = JSON.parse(serializedOp);
    for (const source of serializedOperation.sources) {
      delete source.granules;
    }

    // TODO - remove the sources from the operation
    const argoParams = [...params, { name: 'operation', value: JSON.stringify(serializedOperation) }];
    return {
      namespace: this.params.namespace,
      serverDryRun: false,
      workflow: {
        metadata: {
          generateName: `${this.params.template}-chain-`,
          namespace: this.params.namespace,
          labels: {
            user,
            request_id: requestId,
          },
        },
        spec: {
          arguments: {
            parameters: argoParams,
          },
          workflowTemplateRef: {
            name: `${this.params.template}-chain`,
          },
        },
      },
    };
  }
}
