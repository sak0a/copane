// An interactive multi-step prompt: a name, then a yes/no question.
import { createInterface } from 'node:readline/promises';
const rl = createInterface({ input: process.stdin, output: process.stdout });
const name = await rl.question('What is your name? ');
const ok = await rl.question(`Create a project for ${name}? [y/N] `);
rl.close();
console.log(ok.trim().toLowerCase() === 'y' ? `Hello ${name}, project created.` : 'Aborted.');
process.exit(ok.trim().toLowerCase() === 'y' ? 0 : 3);
