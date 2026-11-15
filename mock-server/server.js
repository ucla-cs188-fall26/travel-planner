//mock backend for frontend testing
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const fixture = name =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/fixtures', name), 'utf8'));
const delay = ms => new Promise(r => setTimeout(r, ms));

//GET endpoints
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/trip', (_req, res) => res.json(fixture('mock-trip.json')));

//POST /api/chat response
app.post('/api/chat', async (req, res) => {
  await delay(600);
  const r = fixture('chat-response.json');
  const turns = (req.body.recentMessages || []).filter(m => m.role === 'user').length; // Includes the current message
  if (turns === 1) return res.json({ ...r, status: 'gathering', comparison: null, itinerary: null });
  if (turns === 2) return res.json({
    ...r, status: 'gathering', question: null, itinerary: null,
    reply: 'Got it. One trade-off before I build the plan: where should you stay?',
  });
  res.json({ ...r, question: null, comparison: null });
});

//POST /api/itinerary/change response
app.post('/api/itinerary/change', async (req, res) => {
  await delay(800);
  res.json(fixture('change-response.json'));
});

app.listen(3000, () => console.log('Mock API on http://localhost:3000'));