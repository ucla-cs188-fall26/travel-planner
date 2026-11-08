const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/fixtures', name), 'utf8'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/trip', (req, res) => res.json(fixture('mock-trip.json')));
app.post('/api/chat', async (req, res) => { await delay(1000); res.json(fixture('chat-response.json')); });
app.post('/api/itinerary/change', async (req, res) => { await delay(1000); res.json(fixture('change-response.json')); });

app.listen(3000, () => console.log('Mock server on http://localhost:3000'));