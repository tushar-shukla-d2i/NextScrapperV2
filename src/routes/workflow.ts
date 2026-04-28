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
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Invalid config payload.' });
    }

    // Ensure JSON-safe payload for Prisma Json field.
    const safeConfig = JSON.parse(JSON.stringify(config));

    const workflow = await prisma.workflow.create({
      data: {
        name: typeof name === 'string' && name.trim() ? name.trim() : 'Visual Flow',
        // Assuming config is a JSON object defining steps
        config: safeConfig
      }
    });
    res.status(201).json(workflow);
  } catch (error: any) {
    console.error('[workflow:create] error:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to create workflow' });
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

// Fetch run status + output (fallback when socket event is missed)
router.get('/run/:runId/result', async (req, res) => {
  try {
    const run = await prisma.workflowRun.findUnique({ where: { id: req.params.runId } });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ status: run.status, output: run.output, error: run.error });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
