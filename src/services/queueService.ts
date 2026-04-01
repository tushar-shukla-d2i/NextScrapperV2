import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { getIO } from '../utils/socket';
import { runScraper } from './scraperService';
import prisma from '../utils/db';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});

export const scraperQueue = new Queue('scraper', { connection });

export const initQueue = () => {
  const worker = new Worker('scraper', async (job) => {
    const io = getIO();

    const emitLog = (msg: string) => {
      io.to(`job_${job.id}`).emit('log', { message: msg, timestamp: new Date().toISOString() });
    };

    // Emit scraped results to the frontend
    const emitData = (results: Record<string, string>[]) => {
      io.to(`job_${job.id}`).emit('scraped_data', { results });
    };

    emitLog(`Worker picked up job ${job.id}`);

    // Update DB to RUNNING
    await prisma.workflowRun.update({
      where: { id: job.id },
      data: { status: 'RUNNING', startedAt: new Date() }
    });

    try {
      // Pass the workflow config (url, steps, extractionTemplate) to the scraper
      const config = (job.data.config as any) || undefined;
      const result = await runScraper(job.id || '', emitLog, emitData, config);

      // Update DB to COMPLETED
      await prisma.workflowRun.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', finishedAt: new Date(), output: result as any }
      });
      return result;
    } catch (error: any) {
      // Update DB to FAILED
      await prisma.workflowRun.update({
        where: { id: job.id },
        data: { status: 'FAILED', finishedAt: new Date(), error: error.message }
      });
      throw error;
    }
  }, { connection });

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed!`);
  });

  worker.on('failed', (job, err) => {
    console.log(`Job ${job?.id} failed with ${err.message}`);
  });
};
