---
title: "As We May Think: The 1945 Vision That Became Trail"
slug: as-we-may-think-vannevar-bush-memex
locale: en
author: trail team
publishedAt: 2026-04-14
excerpt: "In July 1945, an American engineer named Vannevar Bush sketched a machine that would change how humanity thinks about knowledge. He called it the memex. Eighty-one years later, we are finally building it."
tags:
  - history
  - memex
  - vannevar-bush
  - knowledge-infrastructure
  - hypertext
category: The 1945 Concept
cover: /images/posts/memex-desk.svg
---

# As We May Think

## The 1945 vision that became Trail

In July 1945, with the Second World War still grinding toward its final weeks, *The Atlantic Monthly* published an essay by a man who had just spent four years coordinating the work of six thousand American scientists. His name was Vannevar Bush. The essay was called **"As We May Think."** It would become one of the quietly most influential pieces of writing in the twentieth century.

Bush had a problem on his mind — not the war, but what should come after it.

{{svg:memex-desk}}

## Who was Vannevar Bush?

Vannevar Bush was born in Everett, Massachusetts in 1890. He taught at Tufts, then joined MIT at the age of twenty-nine, where he built some of the first analog computers and helped pioneer electrical engineering as a discipline. In 1940, President Roosevelt appointed him chairman of the National Defense Research Committee. A year later, Bush became director of the newly created **Office of Scientific Research and Development** (OSRD) — the organization that would coordinate American scientific effort during the war, from radar to penicillin to, eventually, the Manhattan Project.

By 1945, Bush had seen what concentrated scientific effort could accomplish. He had also seen what it could destroy. And he was worried that once the war ended, the thousands of brilliant minds who had been focused on a single goal would scatter, and their collective knowledge would be lost to the fragmented noise of academic publishing.

> *Professionally our methods of transmitting and reviewing the results of research are generations old and by now are totally inadequate for their purpose.*
> — Vannevar Bush, *As We May Think*, 1945

His worry was not that humanity had too little information. His worry was that it had too much — and no way to navigate it.

## The information problem

Bush argued that the total record of human knowledge was expanding far faster than any individual could read, let alone synthesize. A researcher studying even a narrow topic could spend years just locating the relevant material, much of which would remain effectively hidden in stacks and drawers and indexes.

The problem, Bush said, was not storage — microfilm was already compact enough to fit the Encyclopædia Britannica into a matchbox. The problem was *retrieval*. Traditional library classification systems forced knowledge into rigid hierarchies, tree structures that bore no resemblance to how the human mind actually works.

{{svg:tree-vs-graph}}

## The memex

To solve this, Bush proposed a device. He called it the **memex** — a portmanteau of *memory* and *extension*.

In Bush's description, the memex was a piece of furniture. A desk, specifically, with slanting translucent screens on top, a keyboard, and sets of buttons and levers. Storage occupied a small portion of the interior; the rest was mechanism — microfilm reels, optical projectors, electromechanical links. A user could purchase books, periodicals, and correspondence already on microfilm and drop them into the desk. Handwritten notes and photographs could be added through a transparent platen: you placed the document on the glass, pulled a lever, and it was photographed onto the next blank space in the reel.

Crucially, the memex could be consulted with "exceeding speed and flexibility." Tap a code on the keyboard and a book's title page appeared on one of the screens. But this was not the revolutionary part. Indexed lookup had existed for centuries. What made the memex radical was what Bush called **associative trails**.

## The Trail: thinking by association

The human mind, Bush observed, does not operate by classification. It operates by association. We follow one thought to the next through webs of connection — resemblance, contrast, causality, memory. Traditional indexes force the mind to slow down and walk the tree. Bush wanted a machine that could keep pace with thought itself.

On the memex, a user could tie any two documents together with a permanent link. More importantly, they could build sequences — *trails* — of linked documents, with their own annotations inserted along the way. The Trail was the memex's core data structure, and it was essentially hypertext, described twenty years before the word was coined.

Bush gave a concrete example. Imagine a user interested in why the short Turkish bow was apparently superior to the English longbow during the Crusades:

> *First he runs through an encyclopedia, finds an interesting but sketchy article, leaves it projected. Next, in a history, he finds another pertinent item, and ties the two together. Thus he goes, building a Trail of many items. Occasionally he inserts a comment of his own... When it becomes evident that the elastic properties of available materials had a great deal to do with the bow, he branches off on a side Trail which takes him through textbooks on elasticity...*

{{svg:trail}}

The Trail is not a search result. It is not retrieval. It is a piece of thinking, captured and made permanent — something that could be shared, inherited, extended. Bush envisioned a world in which *"wholly new forms of encyclopedias will appear, ready made with a mesh of associative trails running through them."*

## What happened next

Bush never built the memex. His group prototyped parts of it, but the machine was always more speculative than practical, and the electromechanical technology of the 1940s was never quite up to the vision. Bush returned to MIT, then presided over the Carnegie Institution until 1955. He continued to refine his ideas in later essays like *Memex Revisited* (1967), and died in 1974.

But the essay had planted a seed.

{{svg:timeline}}

**Ted Nelson** coined the word *hypertext* in 1965 and spent a lifetime pursuing a system called Xanadu that would realize Bush's associative trails at planetary scale. Xanadu never shipped in full, but its influence is everywhere.

**Douglas Engelbart** read "As We May Think" shortly after its publication and spent the next two decades trying to build it. His 1968 "Mother of All Demos" at the Fall Joint Computer Conference showed the world the computer mouse, the graphical user interface, real-time collaborative editing, hypertext linking, and video conferencing — all of it directly inspired by Bush's memex.

**Tim Berners-Lee** built the World Wide Web at CERN in 1989. The web's basic primitive — a document that can link to any other document — is the memex Trail stripped to its minimum. Bush's dream of a global network of associatively linked knowledge was finally, imperfectly, realized.

And yet, something was missing.

## The gap the web left behind

The web gave us the link. It did not give us the **Trail**. A search returns a list of URLs ranked by an algorithm that no one fully understands. The burden of weaving those URLs into a coherent piece of thinking falls entirely on the reader, who must then store their synthesis in some external place — a notebook, a document, a blog post — that is itself disconnected from the sources it draws on.

Retrieval-augmented generation, the dominant AI pattern of the early 2020s, took this a step further in the wrong direction. RAG treats knowledge as fragments to be fetched at query time and assembled just-in-time by a language model. There is no persistent wiki. There is no compounding. Every question starts from scratch. Every answer is disposable.

Bush would have recognized the problem immediately. This is not how the mind works. This is not what he drew.

## From Memex to Trail

In October 2025, Andrej Karpathy described a different pattern: the **LLM Wiki**. Instead of retrieving fragments at query time, a language model compiles knowledge at *ingest* time into a persistent, cross-referenced wiki — a living document that an AI maintains on behalf of a human curator. Every new source is not just stored, it is *integrated*. The wiki accumulates. Knowledge compounds. Curators review what the machine proposes and approve what is worth keeping.

This is the memex. Not metaphorically — structurally. The associative trails are wiki links. The ingest pipeline is the transparent platen. The curator is the human operator choosing which trails to preserve. Even the critique of hierarchy versus association is the same, eighty-one years later.

That is what **Trail** is. The name is deliberate. We are not building another search engine, and we are not building another RAG layer. We are building the machine Vannevar Bush described in July 1945, using the one technology he could not have anticipated: large language models capable of reading, understanding, and compiling human knowledge into the associative structures he imagined.

> *The applications of science ... may yet allow [humanity] truly to encompass the great record and to grow in the wisdom of race experience.*
> — Vannevar Bush, *As We May Think*, 1945

Eighty-one years later, we are finally building what he asked for.

---

### Further reading

- Vannevar Bush, [*As We May Think*](https://www.theatlantic.com/magazine/archive/1945/07/as-we-may-think/303881/) — The Atlantic, July 1945
- [*As We May Think* on Wikipedia](https://en.wikipedia.org/wiki/As_We_May_Think)
- [History of Information — *In "As We May Think" Vannevar Bush Envisions Mechanized Information Retrieval and the Concept of Hypertext*](https://www.historyofinformation.com/detail.php?id=676)
- James M. Nyce & Paul Kahn, *From Memex to Hypertext: Vannevar Bush and the Mind's Machine* (Academic Press, 1991)
