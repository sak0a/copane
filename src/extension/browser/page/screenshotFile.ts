// browser_screenshot's `path`: the image also saved as a file, for agents whose client does not pass
// images on to the model but who can open files. Where it may be written is agentFile.ts's rule; this
// is the format from the file name and the mark that shows a file was written by the tool (so it may be
// overwritten by it, and nothing else is). Pure.

export type ShotFormat = 'jpeg' | 'png';

export const SHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
export const SHOT_EXTENSION_HINT = 'The path must end in .png, .jpg or .jpeg (e.g. "screenshot.png").';

/** Text the tool puts into every image it saves; a file whose first bytes hold it may be overwritten. */
export const SHOT_MARK = 'Copane browser_screenshot';

/**
 * The format of a screenshot saved to `path`: the one asked for, else the one the extension names
 * ("shot.png" gives a PNG), else jpeg. An error when the extension contradicts the format asked for;
 * a path with another extension is refused by the file rules (SHOT_EXTENSIONS).
 */
export function shotFormat(path: string, requested: ShotFormat | undefined): { format: ShotFormat } | { error: string } {
  const ext = /\.[^./\\]*$/.exec(path)?.[0].toLowerCase();
  const named: ShotFormat | undefined = ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : undefined;
  if (requested && named && requested !== named) {
    return {
      error: `The path ends in ${ext} but format is ${requested}; end it in ${requested === 'png' ? '.png' : '.jpg'} or leave format out.`,
    };
  }
  return { format: requested ?? named ?? 'jpeg' };
}

/** True when the first bytes of an existing file (read as text) show the tool saved it. */
export function isSavedShot(head: string): boolean {
  return head.includes(SHOT_MARK);
}

/**
 * The image with the mark added where viewers ignore it: a PNG tEXt chunk ("Software") after IHDR, a
 * JPEG comment after the JFIF header. Undefined when the bytes are neither.
 */
export function markShot(data: Buffer): { data: Buffer; format: ShotFormat } | undefined {
  const mark = Buffer.from(SHOT_MARK, 'latin1');
  if (data.length >= 33 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
    const body = Buffer.concat([Buffer.from('tEXtSoftware\0', 'latin1'), mark]);
    const chunk = Buffer.alloc(body.length + 8);
    chunk.writeUInt32BE(body.length - 4, 0);
    body.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(body), body.length + 4);
    return {
      data: Buffer.concat([data.subarray(0, 33), chunk, data.subarray(33)]),
      format: 'png',
    };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // After APP0 (JFIF), which must come first, when there is one; else right after the start marker.
    let at = 2;
    if (data[2] === 0xff && data[3] === 0xe0 && data.length >= 6) at = 4 + data.readUInt16BE(4);
    const comment = Buffer.alloc(4 + mark.length);
    comment[0] = 0xff;
    comment[1] = 0xfe;
    comment.writeUInt16BE(2 + mark.length, 2);
    mark.copy(comment, 4);
    return {
      data: Buffer.concat([data.subarray(0, at), comment, data.subarray(at)]),
      format: 'jpeg',
    };
  }
  return undefined;
}

let table: Uint32Array | undefined;

function crc32(buf: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
