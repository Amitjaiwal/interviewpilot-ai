import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('escapes raw HTML so model output cannot inject markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **bold** <script>x</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders fenced code blocks with a language label and copy control', () => {
    const html = renderMarkdown('Intro\n```java\nint x = a < b ? 1 : 2;\n```\nAfter');
    expect(html).toContain('<span>java</span>');
    expect(html).toContain('copy-code');
    expect(html).toContain('int x = a &lt; b ? 1 : 2;');
    expect(html).toContain('<p>After</p>');
  });

  it('renders an unterminated fence while streaming', () => {
    const html = renderMarkdown('```python\nprint("hi")');
    expect(html).toContain('<pre><code>print(&quot;hi&quot;)</code></pre>');
  });

  it('renders lists, headings, inline code and tables', () => {
    const html = renderMarkdown('## Title\n- one `x`\n- two\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h4>Title</h4>');
    expect(html).toContain('<ul><li>one <code>x</code></li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>2</td>');
  });

  it('renders fences indented inside list items as code blocks', () => {
    const html = renderMarkdown('- **On a variable:** example:\n  ```java\n  final int MAX = 1;\n    nested();\n  ```\n- next item');
    expect(html).toContain('<pre><code>final int MAX = 1;\n  nested();</code></pre>');
    expect(html).not.toContain('```');
    expect(html).toContain('<li>next item</li>');
  });

  it('handles an empty code block and text right after a closing fence', () => {
    const html = renderMarkdown('```\n```\nDone');
    expect(html).toContain('<pre><code></code></pre>');
    expect(html).toContain('<p>Done</p>');
  });

  it('does not treat asterisks in code as emphasis', () => {
    expect(renderMarkdown('Use `a*b*c` here')).toContain('<code>a*b*c</code>');
  });
});
