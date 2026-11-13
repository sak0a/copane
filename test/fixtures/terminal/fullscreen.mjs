// A full-screen program on the alternate screen that quits on "q".
process.stdout.write('\x1b[?1049h\x1b[H\x1b[2J');
process.stdout.write('FULLSCREEN DEMO\r\n\r\n  item one\r\n  item two\r\n');
process.stdout.write(`\x1b[${process.stdout.rows || 24};1H-- press q to quit --`);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => {
  if (chunk.toString().includes('q')) {
    process.stdout.write('\x1b[?1049l');
    console.log('left full screen');
    process.exit(0);
  }
});
