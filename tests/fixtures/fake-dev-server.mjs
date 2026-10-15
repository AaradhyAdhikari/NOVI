// Test double for a project's dev server (npm run dev): serves "fake site" and prints its address
// like Vite does. argv[2]: 'crash' = print an error and exit; 'quit' = exit after 300 ms.
import http from 'node:http';

if (process.argv[2] === 'crash') {
  console.error("Error: Cannot find module 'vite'");
  process.exit(1);
}
const server = http.createServer((req, res) => res.end(`fake site ${req.url}`));
server.listen(0, '127.0.0.1', () => {
  console.log(`  VITE ready\n  ➜  Local:   http://localhost:${server.address().port}/`);
  if (process.argv[2] === 'quit') setTimeout(() => process.exit(0), 300);
});
