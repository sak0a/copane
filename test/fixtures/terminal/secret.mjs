// A password prompt that does not echo what is typed (like `read -s`, ssh or sudo).
process.stdout.write('Password: ');
process.stdin.setRawMode(true);
process.stdin.resume();
let typed = '';
process.stdin.on('data', chunk => {
  for (const ch of chunk.toString('utf8')) {
    if (ch === '\x03') process.exit(130);
    if (ch === '\r' || ch === '\n') {
      process.stdout.write(`\r\nreceived ${typed.length} chars\r\n`);
      process.exit(typed.length > 0 ? 0 : 1);
    }
    typed += ch;
  }
});
