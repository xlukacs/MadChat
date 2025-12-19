const { normalizeMCPImageResult } = require('../MCP');

describe('normalizeMCPImageResult', () => {
  it('returns original result when no image urls found', () => {
    const input = { message: 'hello' };
    expect(normalizeMCPImageResult(input)).toEqual(input);
  });

  it('wraps http image urls into artifact content', () => {
    const input = { urls: ['https://example.com/test.png'] };
    const normalized = normalizeMCPImageResult(input);

    expect(normalized?.artifact?.content?.[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/test.png' },
    });
    expect(normalized.output).toBeDefined();
  });

  it('wraps data urls inside nested structures', () => {
    const input = [{ result: { image: { url: 'data:image/png;base64,abc' } } }];
    const normalized = normalizeMCPImageResult(input);
    expect(normalized.artifact.content[0].image_url.url).toContain('data:image/png');
  });
});

