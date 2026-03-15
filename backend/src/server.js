const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const sessionManager = require('./sessionManager');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, '../../frontend')));

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  console.log('New WebSocket connection established');
  
  try {
    const session = await sessionManager.initSession(ws);
    
    ws.on('close', () => {
      console.log(`Session ${session.sessionId} disconnected`);
      if (session.liveSession) session.liveSession.close();
      if (session.proSession) session.proSession.close();
    });

  } catch(e) {
    console.error('Session init error:', e);
    ws.close();
  }
});

// To fulfill Cloud Run requirements safely
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});
