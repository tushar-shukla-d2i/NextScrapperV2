import { Router } from 'express';
import prisma from '../utils/db';
import { scraperQueue } from '../services/queueService';

const router = Router();
// We logic handled in utils/db.ts


// Get all workflows
router.get('/', async (req, res) => {
  try {
    const workflows = await prisma.workflow.findMany();
    res.json(workflows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch workflows' });
  }
});

// Create a new workflow
router.post('/', async (req, res) => {
  try {
    const { name, config } = req.body;
    const workflow = await prisma.workflow.create({
      data: {
        name,
        // Assuming config is a JSON object defining steps
        config
      }
    });
    res.status(201).json(workflow);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

// Dispatch Scraper Job
router.post('/run/:id', async (req, res) => {
  try {
    const workflowId = req.params.id;
    const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    // 1. Create a pending run in the DB
    const run = await prisma.workflowRun.create({
      data: {
        workflowId,
        status: 'PENDING'
      }
    });

    // 2. Dispatch to BullMQ using the Run ID as the Job ID
    await scraperQueue.add('scrape', { workflowId, config: workflow.config }, { jobId: run.id });

    // 3. Return the jobId so the frontend can listen to WebSocket room `job_${run.id}`
    res.status(202).json({ jobId: run.id, status: 'QUEUED' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
