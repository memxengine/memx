import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

function extractPageContent(): { title: string; content: string } | null {
  try {
    const documentClone = document.cloneNode(true) as Document
    const reader = new Readability(documentClone, {
      keepClasses: false,
      charThreshold: 0,
    })
    const article = reader.parse()

    if (!article) {
      return null
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })

    turndown.addRule('remove-scripts', {
      filter: ['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'header'],
      replacement: () => '',
    })

    const markdown = turndown.turndown(article.content)

    return {
      title: article.title || document.title || 'Untitled',
      content: markdown,
    }
  } catch (err) {
    console.error('Trail Clipper: extraction failed', err)
    return null
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'extract') {
    const result = extractPageContent()
    sendResponse(result)
  }
})
