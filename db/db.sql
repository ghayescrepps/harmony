--- This file contains the commands to create a database from scratch

CREATE TABLE `jobs` (
  `id` integer not null primary key autoincrement,
  `jobID` char(36) not null,
  `requestId` char(36) not null,
  `username` varchar(255) not null,
  `status` text check (`status` in ('accepted', 'running', 'running_with_errors', 'successful', 'failed', 'canceled', 'paused', 'previewing', 'complete_with_errors')) not null,
  `message` varchar(4096) not null,
  `progress` integer not null,
  `batchesCompleted` integer not null,
  `createdAt` datetime not null,
  `updatedAt` datetime not null,
  `request` varchar(4096) not null default 'unknown',
  `isAsync` boolean,
  `numInputGranules` integer not null default 0,
  `collectionIds` text not null,
  `ignoreErrors` boolean not null
);

CREATE TABLE `job_links` (
  `id` integer not null primary key autoincrement,
  `jobID` char(36) not null,
  `href` varchar(4096) not null,
  `type` varchar(255),
  `title` varchar(255),
  `rel` varchar(255),
  `temporalStart` datetime,
  `temporalEnd` datetime,
  `bbox` varchar(255),
  `createdAt` datetime not null,
  `updatedAt` datetime not null,
  FOREIGN KEY(jobID) REFERENCES jobs(jobID)
);

CREATE TABLE `job_errors` (
  `id` integer not null primary key autoincrement,
  `jobID` char(36) not null,
  `url` varchar(4096) not null,
  `message` varchar(4096) not null,
  `createdAt` datetime not null,
  `updatedAt` datetime not null,
  FOREIGN KEY(jobID) REFERENCES jobs(jobID)
);

CREATE TABLE `work_items` (
  `id` integer not null primary key autoincrement,
  `jobID` char(36) not null,
  `workflowStepIndex` integer not null,
  `scrollID` varchar(4096),
  `serviceID` varchar(255) not null,
  `status` text check (`status` in ('ready', 'running', 'successful', 'failed', 'canceled')) not null,
  `stacCatalogLocation` varchar(255),
  `totalGranulesSize` double precision not null default 0,
  `retryCount` integer not null default 0,
  `duration` float not null default -1.0,
  `startedAt` datetime,
  `createdAt` datetime not null,
  `updatedAt` datetime not null,
  FOREIGN KEY(jobID) REFERENCES jobs(jobID)
  FOREIGN KEY(jobID, workflowStepIndex) REFERENCES workflow_steps(jobID, stepIndex)
);

CREATE TABLE `workflow_steps` (
  `id` integer not null primary key autoincrement,
  `jobID` char(36) not null,
  `serviceID` varchar(255) not null,
  `stepIndex` integer not null,
  `workItemCount` integer not null,
  `hasAggregatedOutput` boolean not null default false,
  `operation` text not null,
  `createdAt` datetime not null,
  `updatedAt` datetime not null,
  FOREIGN KEY(jobID) REFERENCES jobs(jobID),
  UNIQUE(jobID, stepIndex)
);

CREATE INDEX jobs_jobID_idx ON jobs(jobID);
CREATE INDEX jobs_updatedAt_id ON jobs(updatedAt);
CREATE INDEX jobs_username_idx ON jobs(username);
CREATE INDEX job_links_jobID_idx ON job_links(jobID);
CREATE INDEX job_errors_jobID_idx ON job_errors(jobID);
CREATE INDEX work_items_jobID_idx ON work_items(jobID);
CREATE INDEX work_items_serviceID_idx ON work_items(serviceID);
CREATE INDEX work_items_status_idx ON work_items(status);
CREATE INDEX workflow_steps_jobID_idx ON workflow_steps(jobID);
CREATE INDEX workflow_steps_jobID_StepIndex_idx ON workflow_steps(jobID, stepIndex);
CREATE INDEX workflow_steps_serviceID_idx ON workflow_steps(serviceID);

