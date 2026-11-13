// Progress output that only makes sense rendered: a \r progress bar, colors, and a multi-line
// display redrawn with cursor-up sequences.
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i <= 10; i++) {
  process.stdout.write(`\r\x1b[36mdownloading\x1b[0m [${'#'.repeat(i)}${'.'.repeat(10 - i)}] ${i * 10}%`);
  await sleep(30);
}
process.stdout.write('\n');
process.stdout.write('task a: waiting\ntask b: waiting\n');
for (const state of ['running', 'done']) {
  await sleep(50);
  process.stdout.write(`\x1b[2A\x1b[2Ktask a: ${state}\n\x1b[2Ktask b: ${state}\n`);
}
console.log('\x1b[1;32mcomplete\x1b[0m');
