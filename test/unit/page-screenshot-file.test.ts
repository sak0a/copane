import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { agentFilePath, writeAgentFile } from '../../src/extension/browser/page/agentFile';
import { imageSize } from '../../src/extension/browser/page/imageSize';
import { isSavedShot, markShot, shotFormat, SHOT_EXTENSION_HINT, SHOT_EXTENSIONS, SHOT_MARK } from '../../src/extension/browser/page/screenshotFile';

/** A real 3×2 RGB PNG. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc(2 * (1 + 3 * 3), 0x80);
  rows[0] = 0;
  rows[10] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** The chunks of a PNG, each with its CRC checked. */
function pngChunks(data: Buffer): string[] {
  const types: string[] = [];
  for (let i = 8; i < data.length; ) {
    const len = data.readUInt32BE(i);
    const body = data.subarray(i + 4, i + 8 + len);
    expect(data.readUInt32BE(i + 8 + len), `CRC of ${body.toString('latin1', 0, 4)}`).toBe(crc32(body));
    types.push(body.toString('latin1', 0, 4));
    i += 12 + len;
  }
  return types;
}

/** The header of a JFIF JPEG, 640×480: SOI, APP0, SOF0 (enough for imageSize). */
function jpeg(): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
}

describe('shotFormat', () => {
  it('takes the format from the extension when none is asked for, jpeg otherwise', () => {
    expect(shotFormat('shot.png', undefined)).toEqual({ format: 'png' });
    expect(shotFormat('a/b/Shot.JPG', undefined)).toEqual({ format: 'jpeg' });
    expect(shotFormat('shot.jpeg', undefined)).toEqual({ format: 'jpeg' });
    expect(shotFormat('shot.webp', undefined)).toEqual({ format: 'jpeg' });
    expect(shotFormat('dir.png/shot', 'png')).toEqual({ format: 'png' });
  });

  it('keeps an asked-for format that matches, refuses one the extension contradicts', () => {
    expect(shotFormat('shot.png', 'png')).toEqual({ format: 'png' });
    expect(shotFormat('shot.jpg', 'jpeg')).toEqual({ format: 'jpeg' });
    expect(shotFormat('shot.png', 'jpeg')).toEqual({ error: 'The path ends in .png but format is jpeg; end it in .jpg or leave format out.' });
    expect(shotFormat('shot.jpeg', 'png')).toEqual({ error: 'The path ends in .jpeg but format is png; end it in .png or leave format out.' });
  });
});

describe('markShot', () => {
  it('adds a valid tEXt chunk after IHDR and keeps the PNG readable', () => {
    const marked = markShot(png())!;
    expect(marked.format).toBe('png');
    expect(pngChunks(marked.data)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(imageSize(marked.data)).toEqual({ width: 3, height: 2 });
    expect(isSavedShot(marked.data.subarray(0, 512).toString('utf8'))).toBe(true);
    expect(isSavedShot(png().toString('utf8'))).toBe(false);
  });

  it('adds a comment after the JFIF header and keeps the JPEG size readable', () => {
    const marked = markShot(jpeg())!;
    expect(marked.format).toBe('jpeg');
    expect([...marked.data.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect([...marked.data.subarray(20, 22)]).toEqual([0xff, 0xfe]);
    expect(marked.data.readUInt16BE(22)).toBe(2 + SHOT_MARK.length);
    expect(imageSize(marked.data)).toEqual({ width: 640, height: 480 });
    expect(isSavedShot(marked.data.subarray(0, 512).toString('utf8'))).toBe(true);
  });

  it('adds the comment right after the start marker of a JPEG without JFIF header', () => {
    const bare = Buffer.concat([Buffer.from([0xff, 0xd8]), jpeg().subarray(20)]);
    const marked = markShot(bare)!;
    expect([...marked.data.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xfe]);
    expect(imageSize(marked.data)).toEqual({ width: 640, height: 480 });
  });

  it('leaves other bytes alone', () => {
    expect(markShot(Buffer.from('GIF89a......'))).toBeUndefined();
  });
});

describe('agentFilePath for screenshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'copane-shot-'));
  const project = join(root, 'project');
  mkdirSync(project);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const env: any = { services: { window: { workspaceFolders: [project] } } };
  const ctx: any = { session: { cwd: undefined } };
  const rules = { extensions: SHOT_EXTENSIONS, extensionHint: SHOT_EXTENSION_HINT, isOurs: isSavedShot, tool: 'browser_screenshot' };

  it('resolves a relative path in the workspace, creates its folder and may overwrite its own file', () => {
    const target = agentFilePath(env, ctx, 'shots/home.png', rules);
    expect(target.file).toBe(join(project, 'shots', 'home.png'));
    const marked = markShot(png())!.data;
    writeAgentFile(target, marked);
    expect(readFileSync(target.file).equals(marked)).toBe(true);
    expect(agentFilePath(env, ctx, 'shots/home.png', rules).file).toBe(target.file);
  });

  it('refuses paths outside, other extensions and files it did not write', () => {
    expect(() => agentFilePath(env, ctx, join(root, 'outside.png'), rules)).toThrow(/outside your working directory and the workspace folders/);
    expect(() => agentFilePath(env, ctx, '../outside.png', rules)).toThrow(/outside your working directory/);
    expect(() => agentFilePath(env, ctx, 'shot.gif', rules)).toThrow(SHOT_EXTENSION_HINT);
    writeFileSync(join(project, 'logo.png'), png());
    expect(() => agentFilePath(env, ctx, 'logo.png', rules)).toThrow(/exists and was not written by browser_screenshot; pick another path/);
  });
});
