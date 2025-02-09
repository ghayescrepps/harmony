import { expect } from 'chai';
import { describe, it } from 'mocha';
import env from '../app/util/env';
import WorkItem from '../../../app/models/work-item';
import { objectStoreForProtocol } from '../../../app/util/object-store';
import * as serviceRunner from '../app/service/service-runner';
import { resolve } from '../../../app/util/url';

const { _getErrorMessage, _getStacCatalogs } = serviceRunner.exportedForTesting;

const errorLog = `
{
  "application": "query-cmr",
  "requestId": "c76c7a30-84a1-40a1-88a0-34a35e47fe8f",
  "message": "found granules",
  "level": "info",
  "timestamp": "2021-09-13T15:08:57.346Z",
  "env_name": "harmony-unknown"
}
{
  "application": "query-cmr",
  "requestId": "c76c7a30-84a1-40a1-88a0-34a35e47fe8f",
  "message": "bad stuff",
  "level": "error",
  "timestamp": "2021-09-14T15:08:57.346Z",
  "env_name": "harmony-unknown"
}
{
  "application": "query-cmr",
  "requestId": "c76c7a30-84a1-40a1-88a0-34a35e47fe8f",
  "message": "second error",
  "level": "error",
  "timestamp": "2021-09-14T15:08:57.346Z",
  "env_name": "harmony-unknown"
}
`;

const nonErrorLog = `
{
  "application": "query-cmr",
  "requestId": "c76c7a30-84a1-40a1-88a0-34a35e47fe8f",
  "message": "found granules",
  "level": "info",
  "timestamp": "2021-09-13T15:08:57.346Z",
  "env_name": "harmony-unknown"
}
`;

const workItemWithErrorJson = 's3://stac-catalogs/abc/123/outputs/';
const workItemWithoutErrorJson = 's3://stac-catalogs/abc/456/outputs/';
const emptyLog = '';

describe('Service Runner', function () {
  describe('_getErrorMessage()', function () {
    before(async function () {
      const s3 = objectStoreForProtocol('s3');
      const errorJson = JSON.stringify({ 'error': 'Service error message', 'category': 'Service' });
      const errorJsonUrl = resolve(workItemWithErrorJson, 'error.json');
      await s3.upload(errorJson, errorJsonUrl, null, 'application/json');
    });
    describe('when there is an error.json file associated with the WorkItem', async function () {
      it('returns the error message from error.json', async function () {
        const errorMessage = await _getErrorMessage(errorLog, workItemWithErrorJson);
        expect(errorMessage).equal('Service error message');
      });
    });
    describe('when the error log has ERROR level entries', async function () {
      it('returns the first error log entry', async function () {
        const errorMessage = await _getErrorMessage(errorLog, workItemWithoutErrorJson);
        expect(errorMessage).equal('bad stuff');
      });
    });
    describe('when the error log has no ERROR level entries', async function () {
      it('returns "unknown error"', async function () {
        const errorMessage = await _getErrorMessage(nonErrorLog, workItemWithoutErrorJson);
        expect(errorMessage).equal('Unknown error');
      });
    });
    describe('when the error log is empty', async function () {
      it('returns "unknown error"', async function () {
        const errorMessage = await _getErrorMessage(emptyLog, workItemWithoutErrorJson);
        expect(errorMessage).equal('Unknown error');
      });
    });
    describe('when the error log is null', async function () {
      it('returns "unknown error"', async function () {
        const errorMessage = await _getErrorMessage(null, workItemWithoutErrorJson);
        expect(errorMessage).equal('Unknown error');
      });
    });
  });

  describe('_getStacCatalogs', function () {
    const nonEmptyCatalogUrl = 's3://stac-catalogs/some/';
    const emptyCatalogUrl = 's3://stac-catalogs/empty/';
    before(async function () {
      const s3 = objectStoreForProtocol('s3');
      const errorJson = JSON.stringify({});
      const catalogUrl = resolve(nonEmptyCatalogUrl, 'catalog0.json');
      await s3.upload(errorJson, catalogUrl, null, 'application/json');
    });
    describe('when the directory has catalogs', async function () {
      it('returns the list of catalogs', async function () {
        const files = await _getStacCatalogs(nonEmptyCatalogUrl);
        expect(files).to.eql(['s3://stac-catalogs/some/catalog0.json']);
      });
    });

    describe('when the directory has no catalogs', async function () {
      it('returns any empty list', async function () {
        const files = await _getStacCatalogs(emptyCatalogUrl);
        expect(files).to.eql([]);
      });
    });
  });

  describe('runQueryCmrFromPull', async function () {
    describe('when an error occurs', async function () {
      const workItem = new WorkItem({
        jobID: '123',
        serviceID: 'abc',
        workflowStepIndex: 0,
        scrollID: 1234,
        operation: { requestID: 'foo' },
        id: 1,
      });
      it('returns an error message', async function () {
        const result = await serviceRunner.runQueryCmrFromPull(workItem);
        expect(result.error).to.be.not.empty;
      });
    });
  });

  describe('runServiceFromPull', async function () {
    describe('when an error occurs', async function () {
      const invocArgs = env.invocationArgs;
      const workItem = new WorkItem({
        jobID: '123',
        serviceID: 'abc',
        workflowStepIndex: 1,
        operation: { requestID: 'foo' },
        id: 1,
      });
      beforeEach(function () {
        env.invocationArgs = 'abc\n123';
      });

      afterEach(function () {
        env.invocationArgs = invocArgs;
      });

      it('returns an error message', async function () {
        const result = await serviceRunner.runServiceFromPull(workItem);
        expect(result.error).to.be.not.empty;
      });
    });
  });
});
