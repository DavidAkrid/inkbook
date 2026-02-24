// Vercel serverless entry point — exports the Express app instead of calling listen()
const app = require('../server');
module.exports = app;
