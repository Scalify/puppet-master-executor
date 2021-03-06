'use strict';

import { logger } from './log.js';
import { isDebug, puppeteerConfig, queueConfig, queueNameJobResults, queueNameJobs } from './config.js';
import { executeJob } from './executeJob.js';
import { sanitize } from './shared.js';

import amqp from 'amqplib';
import puppeteer from 'puppeteer-core';

const defaultJob = {
    modules: {},
    code: "",
    vars: {}
};

async function handleJob(job) {
    let browser;
    try {
        logger.debug(`Creating browser`);
        browser = await puppeteer.launch(puppeteerConfig);

        logger.debug(`Executing script '${sanitize(job.code)}', having the modules ${Object.keys(job.modules).join(",")} and ${Object.keys(job.vars).length} variables`);
        const result = await executeJob(browser, logger, job);

        logger.debug(`Closing browser`);
        await browser.close();

        logger.debug(`Done executing task`);
        logger.info(`Results: ${Object.keys(result.results).length}, Error: ${result.error}, Logs: ${result.logs.length}`);

        return result;
    } catch (e) {
        logger.error(e);
        return {
            logs: [],
            error: e.toString(),
            results: {},
            finished_at: null,
            started_at: null,
            duration: 0,
        };
    } finally {
        if (browser && browser.close) {
            await browser.close();
        }
    }

    return null;
}

async function handleRawMessage(ch, msg) {
    const job = Object.assign({}, defaultJob, JSON.parse(msg.content.toString()));
    const result = await handleJob(job);
    const resultJson = JSON.stringify({
        uuid: job.uuid,
        ...result,
    });

    console.log(resultJson);

    await ch.sendToQueue(queueNameJobResults, Buffer.from(resultJson));
    await ch.ack(msg);
}

(async () => {
    logger.info(`Running chrome on: ${puppeteerConfig.executablePath}`);
    logger.info(`Starting with browser args: ${puppeteerConfig.args}`);

    let consumer;
    try {
        logger.info(`Connecting to queue as ${queueConfig.username}@${queueConfig.host}:${queueConfig.port}`)
        const conn = await amqp.connect(`amqp://${queueConfig.username}:${queueConfig.password}@${queueConfig.host}:${queueConfig.port}`);
        const ch = await conn.createChannel();

        process.once('SIGINT', () => conn.close());

        await ch.prefetch(1);

        ch.consume(queueNameJobs, (msg) => handleRawMessage(ch, msg), { noAck: false });
        logger.info("Waiting for tasks");

    } catch (e) {
        logger.error(e);

        if (consumer && consumer.stop) {
            try {
                consumer.stop();
            } catch (e) {
                logger.error(`Error stopping consumer: ${e}`);
            }
        }

        process.exit(1);
    }
})();
