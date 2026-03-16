const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('Connected to local WS server');
  console.log('Sending start_voice_setup...');
  ws.send(JSON.stringify({ type: 'start_voice_setup' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Received from WS:', msg.type, msg.question || '');
  if (msg.type === 'setup_listening') {
     console.log('Server is ready for voice. Sending dummy audio.. or just passing params directly.');
     ws.send(JSON.stringify({ 
        type: 'story_params', 
        params: { setting: "A dark forest", moral: "courage", userName: "Bob" }
     }));
  }
  if (msg.type === 'setup_ready') {
     console.log('Waiting for greeting...');
  }
  if (msg.type === 'text') {
     console.log('Greeting from server:', msg.content);
     setTimeout(() => process.exit(0), 10000);
  }
});
