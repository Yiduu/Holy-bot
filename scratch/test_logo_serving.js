const axios = require('axios');
const http = require('http');
require('dotenv').config();

// Start the server inline or just check if it serves correctly when running.
// Wait, we can launch the server locally on a different port for this test!
process.env.PORT = 8089;
const server = require('../server.js');

async function testLogo() {
  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    const res = await axios.get('http://localhost:8089/Holy%20logo1.png');
    console.log('Logo request status:', res.status);
    console.log('Logo headers:', res.headers['content-type']);
  } catch (error) {
    console.error('Logo request failed:', error.message);
  }

  process.exit(0);
}

testLogo();
