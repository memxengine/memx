// i18n — Danish + English strings. Toggle via top-bar.
// Ported verbatim from the Claude Design handoff bundle (copy.jsx).

import type { VNode } from 'preact';

export type Lang = 'da' | 'en';

export interface Copy {
  metaRail: string;
  skip: string;
  save: string;
  prev: string;
  next: string;
  finish: string;
  tweaksBtn: string;
  footerLive: string;
  footerRight: string;
  steps: { no: string; label: string }[];
  s1: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    bullets: [string, string, string][];
    cta: string;
    time: string;
  };
  s2: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    nameLabel: string;
    nameHint: string;
    namePh: string;
    slugLabel: string;
    slugHint: string;
    descLabel: string;
    descHint: string;
    descPh: string;
    sub: string;
  };
  s3: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    templates: {
      k: TemplateKey;
      t: string;
      s: string;
      d: string;
      tags: string[];
    }[];
    alt: string;
  };
  s4: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    drop: string;
    dropSub: string;
    browse: string;
    connectors: string;
    connectorSub: string;
    samples: SourceSample[];
  };
  s5: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    roles: [string, string, string][];
    addRow: string;
    sendInvites: string;
    emailPh: string;
  };
  s6: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    phases: string[];
    replay: string;
    autoApprove: string;
  };
  s7: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    ph: string;
    suggest: string[];
  };
  sDone: {
    eyebrow: string;
    h1: VNode;
    lede: string;
    checks: string[];
    openAdmin: string;
    docs: string;
    tip: string;
  };
  diagrams: Diagrams;
}

/** All text rendered *inside* the schematic frames on the right column.
 * Kept flat-per-step so each diagram component can take just its own slice
 * as a `d` prop rather than the whole COPY tree. */
export interface Diagrams {
  scale: string;
  s1: {
    frameTitle: string;
    caption: string;
    source: string;
    sourceMeta: string;
    engine: string;
    engineMeta: string;
    neuron: string;
    neuronMeta: string;
    curator: string;
    curatorMeta: string;
    quote: string;
    quoteAttrib: string;
  };
  s2: {
    frameTitle: string;
    caption: string;
    namespace: string;
    sources: string;
    sourcesMeta: string;
    neuron: string;
    neuronMeta: string;
    queue: string;
    displayName: string;
    figLabel: string;
    storage: string;
    untitled: string;
  };
  s3: {
    frameTitle: string;
    caption: string;
    selectPrompt: string;
    figLabel: string;
    mutable: string;
  };
  s4: {
    frameTitle: string;
    /** `{n}` interpolated; separate strings for count=1 vs count≠1 because
     * Danish / Norwegian / Swedish pluralise the whole noun, not just +s. */
    captionOne: string;
    captionMany: string;
    /** `{n}` → count, `{kb}` → size in kb. One / many forms. */
    countOne: string;
    countMany: string;
    pipeline: string;
    neurons: string;
    figLabel: string;
    media: string;
  };
  s5: {
    frameTitle: string;
    captionOne: string;
    captionMany: string;
    kb: string;
    admin: string;
    curator: string;
    reader: string;
    figLabel: string;
    memberOne: string;
    memberMany: string;
  };
  s6: {
    frameTitle: string;
    /** `{phase}` → 1..4, `{n}` → neuron count, `{q}` → queued count. */
    captionTpl: string;
    sourceFile: string;
    rawBytes: string;
    compile: string;
    phases: { read: string; extract: string; compile: string; link: string };
    figLabel: string;
    /** `{phase}` → 1..4. */
    phaseTpl: string;
  };
  s7: {
    frameTitle: string;
    caption: string;
    query: string;
    fts5: string;
    neurons: string;
    answer: string;
    citations: string;
    figLabel: string;
    provenance: string;
    motto: string;
  };
}

export type TemplateKey =
  | 'blank'
  | 'personal'
  | 'clinic'
  | 'engineering'
  | 'research'
  | 'legal';

export interface SourceSample {
  n: string;
  s: string;
  status: 'ok' | 'work' | 'idle';
  label: string;
}

export const COPY: Record<Lang, Copy> = {
  da: {
    metaRail: 'TRAIL · INITIALIZE NODE · SEQUENCE 01–07',
    skip: 'Spring over',
    save: 'Gem & luk',
    prev: '← Tilbage',
    next: 'Næste →',
    finish: 'Afslut opsætning',
    tweaksBtn: 'Tweaks',
    footerLive: 'ENGINE v0.1.3 · LIVE',
    footerRight: 'As we may think.',

    steps: [
      { no: '01', label: 'Koncept' },
      { no: '02', label: 'Knowledge Base' },
      { no: '03', label: 'Skabelon' },
      { no: '04', label: 'Kilder' },
      { no: '05', label: 'Team' },
      { no: '06', label: 'Ingest' },
      { no: '07', label: 'Query' },
    ],

    s1: {
      eyebrow: 'SEKVENS 01 — MEMEX REVISITED',
      h1: (
        <>
          Velkommen til trail.
          <br />
          <em>En maskine, der kompilerer — ikke søger.</em>
        </>
      ),
      lede:
        'Vannevar Bush skitserede i 1945 en maskine, der kunne følge tankens associationer. Firs år senere bygger vi den. I løbet af de næste syv trin sætter vi din første Knowledge Base op og fodrer den med virkeligheden.',
      bullets: [
        ['K01', 'LLM-kompilerede Neurons', 'Kilder fragmenteres ikke — en sprogmodel læser dem og opdaterer en persistent graf af Neurons.'],
        ['K02', 'Associative trails', 'Hvert Neuron linker bidireksjonelt til sine kilder og til relaterede Neurons.'],
        ['K03', 'Curator, not dictator', 'LLM’en foreslår. Du godkender. Intet rammer Neurons uden dit ja.'],
      ],
      cta: 'Start opsætning',
      time: '≈ 4 min · 7 trin',
    },

    s2: {
      eyebrow: 'SEKVENS 02 — KB PRIMITIVE',
      h1: (
        <>
          Giv din Knowledge Base <em>et navn.</em>
        </>
      ),
      lede:
        'En Knowledge Base er trail’s grund-primitiv: et isoleret namespace med sine egne Sources, Neurons og Curation Queue. Du kan have flere per organisation.',
      nameLabel: 'Display-navn',
      nameHint: 'Synligt for kuratorer og chat-widget',
      namePh: 'fx Klinik-viden · Sanne',
      slugLabel: 'Slug',
      slugHint: 'Bruges i URL og API-stier',
      descLabel: 'Kort beskrivelse',
      descHint: 'En linje der forklarer hvad der hører hjemme her',
      descPh: 'Alt om vores arbejde med…',
      sub: 'SLUG GENERERES AUTOMATISK — KAN REDIGERES',
    },

    s3: {
      eyebrow: 'SEKVENS 03 — SCHEMA TEMPLATE',
      h1: (
        <>
          Vælg en skabelon for <em>skemaet.</em>
        </>
      ),
      lede:
        'Skabelonen bestemmer hvilke typer Neurons compileren laver som standard — entiteter, koncepter, procedurer, patienter, kildetyper. Du kan altid ændre det senere.',
      templates: [
        { k: 'blank', t: 'Blank', s: 'Generisk', d: 'Tre Neuron-typer: entity, concept, source. Ingen antagelser.', tags: ['entity', 'concept', 'source'] },
        { k: 'personal', t: 'Personal Memex', s: 'Solo-kurator', d: 'Optimeret til en enkelt person: notater, bogmærker, citater, mennesker.', tags: ['person', 'note', 'quote'] },
        { k: 'clinic', t: 'Klinik', s: 'Fx FysioDK · Sanne', d: 'Patient-forløb, protokoller, øvelser, diagnoser og relationer mellem dem.', tags: ['patient', 'protocol', 'diagnosis'] },
        { k: 'engineering', t: 'Engineering', s: 'Produkt-team', d: 'RFC’er, incidents, runbooks, services, on-call, arkitektur-beslutninger.', tags: ['service', 'adr', 'runbook'] },
        { k: 'research', t: 'Research', s: 'Akademisk', d: 'Papers, forfattere, koncepter, citationer. Egnet til litteraturreviews.', tags: ['paper', 'author', 'claim'] },
        { k: 'legal', t: 'Juridisk', s: 'Advokat · Compliance', d: 'Sager, parter, klausuler, domme. Streng provenance.', tags: ['case', 'clause', 'ruling'] },
      ],
      alt: 'Jeg opretter selv et skema senere',
    },

    s4: {
      eyebrow: 'SEKVENS 04 — SOURCES',
      h1: (
        <>
          Træk det første materiale <em>ind i maskinen.</em>
        </>
      ),
      lede:
        'trail kan læse PDF, Markdown, txt, HTML-clips og live-kildekode via MCP. Drop en håndfuld filer her — du kan tilføje mere når som helst. Tomt er også OK; du kan komme tilbage senere.',
      drop: 'Træk filer hertil',
      dropSub: 'Eller klik for at vælge · max 50mb pr fil',
      browse: 'Vælg filer',
      connectors: 'Forbind kanaler',
      connectorSub: 'Kontinuerlig indlæsning via integrationer',
      samples: [
        { n: 'sanne-protokol-skulder.pdf', s: 'PDF · 412 kb · 18 sider', status: 'ok', label: 'LÆST' },
        { n: 'behandlingsnoter-2026-q1.md', s: 'MD · 34 kb', status: 'work', label: 'KØRER' },
        { n: 'case-haslev-marianne.pdf', s: 'PDF · 208 kb · 9 sider', status: 'idle', label: 'KØ' },
      ],
    },

    s5: {
      eyebrow: 'SEKVENS 05 — ROSTER · RBAC',
      h1: (
        <>
          Inviter dit team. <em>Curator, not dictator.</em>
        </>
      ),
      lede:
        'trail er ikke en solo-maskine — det er kuratoriet, der gør den troværdig. Giv dine kolleger adgang med tydelige roller. Du kan udvide listen senere.',
      roles: [
        ['ADM', 'Admin', 'Fuld kontrol · kan invitere · rediger skema'],
        ['CUR', 'Curator', 'Godkender kandidater · redigerer Neurons'],
        ['RDR', 'Reader', 'Læser neuron · chat · ingen skrive-rettigheder'],
      ],
      addRow: '+ Tilføj kollega',
      sendInvites: 'Send invitationer',
      emailPh: 'kollega@firma.dk',
    },

    s6: {
      eyebrow: 'SEKVENS 06 — FIRST COMPILATION',
      h1: (
        <>
          Nu kompileres de første <em>Neurons</em>.
        </>
      ),
      lede:
        'Se hvordan en kilde bliver til en sammenhængende Neuron-graf. Maskinen læser, udtrækker entiteter, skriver Neuron-sider, og forbinder dem med eksisterende viden.',
      phases: ['LÆS KILDE', 'UDTRÆK ENTITETER', 'KOMPILÉR NEURONS', 'SKAB TRAILS'],
      replay: '↻ Afspil igen',
      autoApprove: 'Auto-godkend Neurons over tillidsgrænse (0.85)',
    },

    s7: {
      eyebrow: 'SEKVENS 07 — QUERY',
      h1: (
        <>
          Spørg dine Neurons om <em>noget rigtigt.</em>
        </>
      ),
      lede:
        'Hver gang du stiller et spørgsmål, er svaret fodnoteret tilbage til det kompilerede Neuron og til den rå kilde. Prøv selv:',
      ph: 'Stil et spørgsmål…',
      suggest: [
        'Hvad er protokollen for frozen shoulder?',
        'Hvem er Marianne fra Haslev?',
        'Sammenfat Q1-behandlingsnoter',
      ],
    },

    sDone: {
      eyebrow: 'NODE INITIALIZED',
      h1: (
        <>
          Din trail er <em>online.</em>
        </>
      ),
      lede:
        'Knowledge Base, skabelon, første kilder, team og første Neurons — alt er sat op. Herfra kører det af sig selv: hver ny kilde styrker grafen.',
      checks: [
        '01 · Koncept forstået',
        '02 · Knowledge Base oprettet',
        '03 · Skabelon valgt',
        '04 · Første kilder oploadet',
        '05 · Team inviteret',
        '06 · Neurons kompileret',
        '07 · Chat verificeret',
      ],
      openAdmin: 'Åbn Admin-dashboard',
      docs: 'Læs dokumentationen',
      tip: 'TIP — Installer MCP-serveren for at ingest’e direkte fra Claude Code & Cursor.',
    },

    diagrams: {
      scale: 'scale 1 : 1 · system/imperial',
      s1: {
        frameTitle: 'fig. 01 — memex revisited',
        caption: 'fig. 01 — kilde → engine → neurons · med kurator-loop',
        source: 'kilde',
        sourceMeta: 'pdf · md · web',
        engine: 'trail engine',
        engineMeta: 'indlæs → kompilér',
        neuron: 'neurons',
        neuronMeta: 'associativ graf',
        curator: 'kurator',
        curatorMeta: 'godkender / afviser',
        quote: '"…a machine which could be consulted with exceeding speed and flexibility."',
        quoteAttrib: 'v. bush · 1945 · the atlantic',
      },
      s2: {
        frameTitle: 'fig. 02 — kb-primitiv',
        caption: 'fig. 02 — kb = (sources, neuron, queue)',
        namespace: 'namespace',
        sources: 'sources',
        sourcesMeta: 'rå · immutable',
        neuron: 'neuron',
        neuronMeta: 'kompileret',
        queue: 'kø · kurér',
        displayName: 'display-navn',
        figLabel: 'fig. 02 — kb-primitiv',
        storage: 'single-tenant · database',
        untitled: 'unavngivet knowledge base',
      },
      s3: {
        frameTitle: 'fig. 03 — neuron-type-kort',
        caption: 'fig. 03 — skema bestemmer compiler-output',
        selectPrompt: 'vælg en skabelon →',
        figLabel: 'fig. 03 — neuron-typer udsendt',
        mutable: 'mutable',
      },
      s4: {
        frameTitle: 'fig. 04 — kilder · tragt · neurons',
        captionOne: 'fig. 04 — {n} fil afventer kompilering',
        captionMany: 'fig. 04 — {n} filer afventer kompilering',
        countOne: '{n} kilde · {kb}kb',
        countMany: '{n} kilder · {kb}kb',
        pipeline: 'pipeline',
        neurons: 'neurons',
        figLabel: 'fig. 04 — ingest-overflade',
        media: 'pdf · md · web · mcp',
      },
      s5: {
        frameTitle: 'fig. 05 — team · rbac',
        captionOne: 'fig. 05 — {n} medlem aktiv',
        captionMany: 'fig. 05 — {n} medlemmer aktiv',
        kb: 'kb',
        admin: 'admin',
        curator: 'kurator',
        reader: 'læser',
        figLabel: 'fig. 05 — team',
        memberOne: '{n} medlem · rbac',
        memberMany: '{n} medlemmer · rbac',
      },
      s6: {
        frameTitle: 'fig. 06 — ingest-pipeline',
        captionTpl: 'fig. 06 — fase {phase} / 4 · {n} neurons · {q} i kø',
        sourceFile: 'KILDE.PDF',
        rawBytes: 'rå bytes',
        compile: 'kompilér',
        phases: { read: 'læs', extract: 'udtræk', compile: 'kompilér', link: 'link' },
        figLabel: 'fig. 06 — ingest-pipeline',
        phaseTpl: 'fase {phase} / 4',
      },
      s7: {
        frameTitle: 'fig. 07 — forespørgsel · syntese',
        caption: 'fig. 07 — hvert udsagn, et spor tilbage',
        query: 'forespørgsel',
        fts5: 'fts5',
        neurons: 'neurons',
        answer: 'svar',
        citations: '[[neuron-link]] citationer',
        figLabel: 'fig. 07 — forespørgsel · syntese',
        provenance: 'proveniens bevaret',
        motto: 'hvert udsagn, et spor tilbage',
      },
    },
  },

  en: {
    metaRail: 'TRAIL · INITIALIZE NODE · SEQUENCE 01–07',
    skip: 'Skip',
    save: 'Save & exit',
    prev: '← Back',
    next: 'Next →',
    finish: 'Finish setup',
    tweaksBtn: 'Tweaks',
    footerLive: 'ENGINE v0.1.3 · LIVE',
    footerRight: 'As we may think.',

    steps: [
      { no: '01', label: 'Concept' },
      { no: '02', label: 'Knowledge Base' },
      { no: '03', label: 'Template' },
      { no: '04', label: 'Sources' },
      { no: '05', label: 'Team' },
      { no: '06', label: 'Ingest' },
      { no: '07', label: 'Query' },
    ],

    s1: {
      eyebrow: 'SEQUENCE 01 — MEMEX REVISITED',
      h1: (
        <>
          Welcome to trail.
          <br />
          <em>A machine that compiles — not searches.</em>
        </>
      ),
      lede:
        'In 1945 Vannevar Bush sketched a machine that could follow the associations of thought. Eighty years on, we are finally building it. Over the next seven steps we will set up your first Knowledge Base and feed it something real.',
      bullets: [
        ['K01', 'LLM-compiled Neurons', "Sources aren't chunked — an LLM reads them and maintains a persistent graph of Neurons."],
        ['K02', 'Associative trails', 'Every Neuron links bidirectionally to its sources and to related Neurons.'],
        ['K03', 'Curator, not dictator', 'The LLM proposes. You dispose. Nothing reaches the Neurons without approval.'],
      ],
      cta: 'Begin setup',
      time: '≈ 4 min · 7 steps',
    },

    s2: {
      eyebrow: 'SEQUENCE 02 — KB PRIMITIVE',
      h1: (
        <>
          Name your <em>Knowledge Base.</em>
        </>
      ),
      lede:
        "A Knowledge Base is trail's fundamental primitive: an isolated namespace with its own Sources, Neurons, and Curation Queue. You can run many per organization.",
      nameLabel: 'Display name',
      nameHint: 'Visible to curators and the chat widget',
      namePh: 'e.g. Clinic Knowledge · Sanne',
      slugLabel: 'Slug',
      slugHint: 'Used in URLs and API paths',
      descLabel: 'Short description',
      descHint: 'One line that explains what belongs here',
      descPh: 'Everything about our work with…',
      sub: 'SLUG AUTO-GENERATED — EDITABLE',
    },

    s3: {
      eyebrow: 'SEQUENCE 03 — SCHEMA TEMPLATE',
      h1: (
        <>
          Choose a <em>schema</em> template.
        </>
      ),
      lede:
        'The template decides which Neuron types the compiler creates by default — entities, concepts, procedures, patients, sources. You can change it any time later.',
      templates: [
        { k: 'blank', t: 'Blank', s: 'Generic', d: 'Three Neuron types: entity, concept, source. Zero assumptions.', tags: ['entity', 'concept', 'source'] },
        { k: 'personal', t: 'Personal Memex', s: 'Solo curator', d: 'Tuned for a single person: notes, bookmarks, quotes, people.', tags: ['person', 'note', 'quote'] },
        { k: 'clinic', t: 'Clinic', s: 'FysioDK · Sanne', d: 'Patient journeys, protocols, exercises, diagnoses and their relationships.', tags: ['patient', 'protocol', 'diagnosis'] },
        { k: 'engineering', t: 'Engineering', s: 'Product team', d: 'RFCs, incidents, runbooks, services, on-call, architecture decisions.', tags: ['service', 'adr', 'runbook'] },
        { k: 'research', t: 'Research', s: 'Academic', d: 'Papers, authors, concepts, citations. Suited to literature reviews.', tags: ['paper', 'author', 'claim'] },
        { k: 'legal', t: 'Legal', s: 'Counsel · Compliance', d: 'Cases, parties, clauses, rulings. Strict provenance.', tags: ['case', 'clause', 'ruling'] },
      ],
      alt: "I'll author my own schema later",
    },

    s4: {
      eyebrow: 'SEQUENCE 04 — SOURCES',
      h1: (
        <>
          Feed the first materials <em>into the engine.</em>
        </>
      ),
      lede:
        'trail reads PDF, Markdown, txt, web-clips, and live source code via MCP. Drop a handful of files here — you can add more any time. Empty is also fine; you can come back later.',
      drop: 'Drop files here',
      dropSub: 'Or click to select · 50mb max per file',
      browse: 'Choose files',
      connectors: 'Connect channels',
      connectorSub: 'Continuous ingest via integrations',
      samples: [
        { n: 'shoulder-protocol-2026.pdf', s: 'PDF · 412 kb · 18 pages', status: 'ok', label: 'READ' },
        { n: 'treatment-notes-q1.md', s: 'MD · 34 kb', status: 'work', label: 'RUNNING' },
        { n: 'case-marianne-haslev.pdf', s: 'PDF · 208 kb · 9 pages', status: 'idle', label: 'QUEUED' },
      ],
    },

    s5: {
      eyebrow: 'SEQUENCE 05 — ROSTER · RBAC',
      h1: (
        <>
          Invite your team. <em>Curator, not dictator.</em>
        </>
      ),
      lede:
        "trail isn't a solo machine — the curatorial body is what makes it trustworthy. Give your colleagues access with explicit roles. Expand the roster whenever you want.",
      roles: [
        ['ADM', 'Admin', 'Full control · can invite · edits schema'],
        ['CUR', 'Curator', 'Approves candidates · edits Neurons'],
        ['RDR', 'Reader', 'Reads neuron · chat · no write access'],
      ],
      addRow: '+ Add colleague',
      sendInvites: 'Send invitations',
      emailPh: 'colleague@company.com',
    },

    s6: {
      eyebrow: 'SEQUENCE 06 — FIRST COMPILATION',
      h1: (
        <>
          Now the first <em>Neurons</em> compile.
        </>
      ),
      lede:
        "Watch how one source becomes a coherent Neuron graph. The machine reads, extracts entities, writes Neuron pages, and links them to what's already known.",
      phases: ['READ SOURCE', 'EXTRACT ENTITIES', 'COMPILE NEURONS', 'FORM TRAILS'],
      replay: '↻ Replay',
      autoApprove: 'Auto-approve Neurons above confidence threshold (0.85)',
    },

    s7: {
      eyebrow: 'SEQUENCE 07 — QUERY',
      h1: (
        <>
          Ask your Neurons <em>something real.</em>
        </>
      ),
      lede:
        'Every answer is footnoted back to the compiled Neuron and to the original source. Try it:',
      ph: 'Ask a question…',
      suggest: [
        'What is the protocol for frozen shoulder?',
        'Who is Marianne from Haslev?',
        'Summarize Q1 treatment notes',
      ],
    },

    sDone: {
      eyebrow: 'NODE INITIALIZED',
      h1: (
        <>
          Your trail is <em>online.</em>
        </>
      ),
      lede:
        'Knowledge Base, template, first sources, team, first Neurons — all set. From here it runs itself: every new source strengthens the graph.',
      checks: [
        '01 · Concept understood',
        '02 · Knowledge Base created',
        '03 · Template chosen',
        '04 · First sources uploaded',
        '05 · Team invited',
        '06 · Neurons compiled',
        '07 · Chat verified',
      ],
      openAdmin: 'Open admin dashboard',
      docs: 'Read the docs',
      tip: 'TIP — Install the MCP server to ingest directly from Claude Code & Cursor.',
    },

    diagrams: {
      scale: 'scale 1 : 1 · system/imperial',
      s1: {
        frameTitle: 'fig. 01 — memex revisited',
        caption: 'fig. 01 — source → engine → neurons · with curator loop',
        source: 'source',
        sourceMeta: 'pdf · md · web',
        engine: 'trail engine',
        engineMeta: 'ingest → compile',
        neuron: 'neurons',
        neuronMeta: 'associative graph',
        curator: 'curator',
        curatorMeta: 'approves / rejects',
        quote: '"…a machine which could be consulted with exceeding speed and flexibility."',
        quoteAttrib: 'v. bush · 1945 · the atlantic',
      },
      s2: {
        frameTitle: 'fig. 02 — kb primitive',
        caption: 'fig. 02 — kb = (sources, neuron, queue)',
        namespace: 'namespace',
        sources: 'sources',
        sourcesMeta: 'raw · immutable',
        neuron: 'neuron',
        neuronMeta: 'compiled',
        queue: 'queue · curate',
        displayName: 'display name',
        figLabel: 'fig. 02 — kb primitive',
        storage: 'single-tenant · database',
        untitled: 'untitled knowledge base',
      },
      s3: {
        frameTitle: 'fig. 03 — neuron type map',
        caption: 'fig. 03 — schema decides compiler output',
        selectPrompt: 'select a template →',
        figLabel: 'fig. 03 — neuron types emitted',
        mutable: 'mutable',
      },
      s4: {
        frameTitle: 'fig. 04 — sources · funnel · neurons',
        captionOne: 'fig. 04 — {n} file pending compile',
        captionMany: 'fig. 04 — {n} files pending compile',
        countOne: '{n} source · {kb}kb',
        countMany: '{n} sources · {kb}kb',
        pipeline: 'pipeline',
        neurons: 'neurons',
        figLabel: 'fig. 04 — ingestion surface',
        media: 'pdf · md · web · mcp',
      },
      s5: {
        frameTitle: 'fig. 05 — roster · rbac',
        captionOne: 'fig. 05 — {n} member active',
        captionMany: 'fig. 05 — {n} members active',
        kb: 'kb',
        admin: 'admin',
        curator: 'curator',
        reader: 'reader',
        figLabel: 'fig. 05 — roster',
        memberOne: '{n} member · rbac',
        memberMany: '{n} members · rbac',
      },
      s6: {
        frameTitle: 'fig. 06 — ingest pipeline',
        captionTpl: 'fig. 06 — phase {phase} / 4 · {n} neurons · {q} queued',
        sourceFile: 'SOURCE.PDF',
        rawBytes: 'raw bytes',
        compile: 'compile',
        phases: { read: 'read', extract: 'extract', compile: 'compile', link: 'link' },
        figLabel: 'fig. 06 — ingest pipeline',
        phaseTpl: 'phase {phase} / 4',
      },
      s7: {
        frameTitle: 'fig. 07 — query · synthesis',
        caption: 'fig. 07 — every claim, a trail back',
        query: 'query',
        fts5: 'fts5',
        neurons: 'neurons',
        answer: 'answer',
        citations: '[[neuron-link]] citations',
        figLabel: 'fig. 07 — query · synthesis',
        provenance: 'provenance preserved',
        motto: 'every claim, a trail back',
      },
    },
  },
};
