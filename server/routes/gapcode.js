import express from 'express';
import { deleteGapcodeSession } from '../projects.js';
import { sessionNamesDb } from '../database/db.js';

const router = express.Router();

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await deleteGapcodeSession(sessionId);
    sessionNamesDb.deleteName(sessionId, 'gapcode');
    res.json({ success: true });
  } catch (error) {
    console.error(`Error deleting GapCode session ${req.params.sessionId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
