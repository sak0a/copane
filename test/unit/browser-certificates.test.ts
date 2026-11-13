import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { describeCertError, hostMatches, hostOf } from '../../src/extension/browser/certificates';

describe('trusted certificate hosts', () => {
  it('matches exact hosts and wildcard domains, case-insensitively', () => {
    expect(hostMatches('localhost', ['localhost'])).toBe(true);
    expect(hostMatches('Build.Corp.Example', ['build.corp.example'])).toBe(true);
    expect(hostMatches('jira.corp.example', ['*.corp.example'])).toBe(true);
    expect(hostMatches('a.b.corp.example', ['*.corp.example'])).toBe(true);
    expect(hostMatches('corp.example', ['*.corp.example'])).toBe(true);
  });

  it('does not match look-alike hosts', () => {
    expect(hostMatches('evilcorp.example', ['*.corp.example'])).toBe(false);
    expect(hostMatches('corp.example.evil.test', ['*.corp.example'])).toBe(false);
    expect(hostMatches('localhost.evil.test', ['localhost'])).toBe(false);
    expect(hostMatches('anything', [])).toBe(false);
    expect(hostMatches('anything', ['', '  '])).toBe(false);
  });

  it('reads the host from a URL, including IPv6 and ports', () => {
    expect(hostOf('https://127.0.0.1:3943/x?y')).toBe('127.0.0.1');
    expect(hostOf('https://[::1]:8443/')).toBe('::1');
    expect(hostOf('not a url')).toBeUndefined();
  });

  it('explains common errors in plain words', () => {
    expect(describeCertError('net::ERR_CERT_AUTHORITY_INVALID')).toMatch(/self-signed/);
    expect(describeCertError('net::ERR_CERT_COMMON_NAME_INVALID')).toMatch(/different host name/);
    expect(describeCertError('net::ERR_CERT_DATE_INVALID')).toMatch(/expired/);
    expect(describeCertError('net::ERR_SOMETHING_ELSE')).toMatch(/ERR_SOMETHING_ELSE/);
  });
});
