import { describe, expect, it } from "vitest";
import { CarouselUnroller } from "../ACP Connector/official-kernel/carousel-unroll.js";

describe("CarouselUnroller", () => {
  it("leaves standard markdown unchanged", () => {
    const unroller = new CarouselUnroller();
    const text = "### Section Header\n\n![Sample Image](https://example.com/sample.png)\n\nSample description text.";
    expect(unroller.unroll(text)).toBe(text);
  });

  it("unrolls a complete ````carousel block to standard markdown", () => {
    const unroller = new CarouselUnroller();
    const raw = `### Gallery Preview

\`\`\`\`carousel
![Slide 1: Architecture Diagram](https://example.com/slide-01.png)
<!-- slide -->
![Slide 2: Sequence Flow](https://example.com/slide-02.png)
<!-- slide -->
![Slide 3: Summary Metrics](https://example.com/slide-03.png)
\`\`\`\`

---
#### Notes and references`;

    const expected = `### Gallery Preview

![Slide 1: Architecture Diagram](https://example.com/slide-01.png)

![Slide 2: Sequence Flow](https://example.com/slide-02.png)

![Slide 3: Summary Metrics](https://example.com/slide-03.png)

---
#### Notes and references`;

    expect(unroller.unroll(raw)).toBe(expected);
  });

  it("handles streaming chunks across carousel boundary", () => {
    const unroller = new CarouselUnroller();
    const chunk1 = "Intro text\n\n````car";
    const chunk2 = "ousel\n![Item 1](https://example.com/1.png)\n<!-- slide -->";
    const chunk3 = "\n![Item 2](https://example.com/2.png)\n``";
    const chunk4 = "``\n\nOutro text";

    let out = "";
    out += unroller.unroll(chunk1, "sess1");
    out += unroller.unroll(chunk2, "sess1");
    out += unroller.unroll(chunk3, "sess1");
    out += unroller.unroll(chunk4, "sess1");

    expect(out).toContain("![Item 1](https://example.com/1.png)");
    expect(out).toContain("![Item 2](https://example.com/2.png)");
    expect(out).not.toContain("````carousel");
    expect(out).not.toContain("<!-- slide -->");
    expect(out).not.toContain("````\n");
    expect(out).toContain("Intro text");
    expect(out).toContain("Outro text");
  });
});
