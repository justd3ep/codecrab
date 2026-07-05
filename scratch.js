fetch('http://localhost:3141/health')
  .then(res => res.text())
  .then(console.log)
  .catch(console.error);
