// web-scraper-markdown.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const url = require('url');

/**
 * URLからフラグメント（#以降）を除去する関数
 * @param {string} urlString URL文字列
 * @returns {string} フラグメントを除去したURL
 */
function removeFragment(urlString) {
  try {
    const parsedUrl = new URL(urlString);
    parsedUrl.hash = '';
    return parsedUrl.toString();
  } catch (e) {
    return urlString;
  }
}

/**
 * ウェブページをスクレイピングしてマークダウン形式で保存する
 * @param {string} targetUrl スクレイピング対象のURL
 * @param {number} maxDepth 最大探索深度
 */
async function scrapeToMarkdown(targetUrl, maxDepth = 2) {
  // フラグメントを除去した対象URLを使用
  targetUrl = removeFragment(targetUrl);
  
  console.log(`スクレイピングを開始: ${targetUrl} (最大深度: ${maxDepth})`);
  
  // 出力ディレクトリの設定
  const outputDir = 'scraped_data';
  const mdOutputDir = path.join(outputDir, 'markdown');
  const imagesDir = path.join(mdOutputDir, 'images');
  
  // ディレクトリを作成
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(mdOutputDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  
  // メタデータ初期化
  const metadata = {
    startUrl: targetUrl,
    startTime: new Date().toISOString(),
    maxDepth: maxDepth,
    pagesScraped: 0,
    markdownFiles: 0
  };
  
  // 訪問済みURLの記録 (フラグメントなしで保存)
  const visitedUrls = new Set();
  // 処理待ちURLのキュー (URL, 深度)
  const urlQueue = [[targetUrl, 0]];
  
  // オリジナルURLとフラグメント除去後のURLのマッピング
  const originalUrls = new Map();
  originalUrls.set(targetUrl, targetUrl);
  
  // ブラウザを起動
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    while (urlQueue.length > 0) {
      // URLキューから次の処理対象を取得
      const [currentUrl, depth] = urlQueue.shift();
      
      // フラグメントを除去したURLを使用
      const normalizedUrl = removeFragment(currentUrl);
      
      // 既に訪問済みの場合はスキップ
      if (visitedUrls.has(normalizedUrl)) {
        continue;
      }
      
      // 最大深度を超えている場合はスキップ
      if (depth > maxDepth) {
        continue;
      }
      
      console.log(`処理中 [深度: ${depth}]: ${currentUrl}`);
      
      // URLを訪問済みに追加 (フラグメントなしで)
      visitedUrls.add(normalizedUrl);
      // オリジナルURLも保存（レポート用）
      originalUrls.set(normalizedUrl, currentUrl);
      
      metadata.pagesScraped++;
      
      // ページを開く
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36');
      
      try {
        // ページに移動（オリジナルURLを使用）
        await page.goto(currentUrl, {
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        
        // ページのメタデータを抽出
        const pageMetadata = await page.evaluate(() => {
          return {
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.content || '',
            canonical: document.querySelector('link[rel="canonical"]')?.href || window.location.href,
          };
        });
        
        // ページコンテンツをマークダウンに変換
        const markdown = await extractContentAsMarkdown(page, imagesDir, currentUrl);
        
        // マークダウンファイル名の作成
        const parsedUrl = new URL(normalizedUrl);
        let fileName = parsedUrl.pathname.replace(/\//g, '_').replace(/^_/, '');
        if (!fileName) fileName = 'index';
        if (!fileName.endsWith('.md')) fileName += '.md';
        
        // マークダウンにメタデータを追加
        const frontMatter = `---
title: "${pageMetadata.title}"
url: "${currentUrl}"
normalizedUrl: "${normalizedUrl}"
description: "${pageMetadata.description}"
date: "${new Date().toISOString()}"
depth: ${depth}
---

`;
        
        // マークダウンファイルを保存
        const mdFilePath = path.join(mdOutputDir, fileName);
        fs.writeFileSync(mdFilePath, frontMatter + markdown);
        metadata.markdownFiles++;
        
        console.log(`マークダウンファイル保存: ${mdFilePath}`);
        
        // ページのスクリーンショットを保存
        const screenshotName = fileName.replace('.md', '.png');
        await page.screenshot({
          path: path.join(outputDir, screenshotName),
          fullPage: true
        });
        
        // リンクを抽出して処理キューに追加（同一ドメインのみ）
        if (depth < maxDepth) {
          const links = await page.evaluate((baseUrl) => {
            const sameDomain = (urlStr) => {
              try {
                // 相対URLの場合はbaseUrlのドメインを使用
                if (urlStr.startsWith('/')) {
                  return true;
                }
                // 絶対URLの場合はドメインを比較
                const base = new URL(baseUrl);
                const url = new URL(urlStr, baseUrl);
                return url.hostname === base.hostname;
              } catch (e) {
                return false;
              }
            };
            
            return Array.from(document.querySelectorAll('a[href]'))
              .map(a => a.href)
              .filter(href => href && !href.startsWith('javascript:') && !href.startsWith('mailto:'))
              .filter(href => sameDomain(href));
          }, currentUrl);
          
          // 重複を除去して新しいリンクをキューに追加
          const uniqueLinks = [...new Set(links)];
          for (const link of uniqueLinks) {
            // フラグメントを除去したURLで重複チェック
            const normalizedLink = removeFragment(link);
            if (!visitedUrls.has(normalizedLink)) {
              urlQueue.push([link, depth + 1]);
            }
          }
        }
      } catch (err) {
        console.error(`ページ処理エラー: ${currentUrl}`, err);
      } finally {
        await page.close();
      }
    }
    
    // インデックスマークダウンを作成
    await createIndexMarkdown(mdOutputDir, visitedUrls, originalUrls, metadata);
    
    // メタデータ更新
    metadata.endTime = new Date().toISOString();
    metadata.duration = (new Date(metadata.endTime) - new Date(metadata.startTime)) / 1000;
    
    // メタデータをファイルに保存
    fs.writeFileSync(
      path.join(outputDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );
    
    console.log('\nスクレイピング完了:');
    console.log(`- 処理ページ数: ${metadata.pagesScraped}`);
    console.log(`- マークダウンファイル数: ${metadata.markdownFiles}`);
    console.log(`- 処理時間: ${metadata.duration.toFixed(1)}秒`);
    
  } catch (error) {
    console.error('スクレイピング全体エラー:', error);
  } finally {
    await browser.close();
  }
}

/**
 * ページコンテンツをマークダウン形式で抽出する
 * @param {Page} page Puppeteerのページオブジェクト
 * @param {string} imagesDir 画像保存ディレクトリ
 * @param {string} baseUrl ベースURL
 * @returns {Promise<string>} マークダウン形式のコンテンツ
 */
async function extractContentAsMarkdown(page, imagesDir, baseUrl) {
  // ページからマークダウンを抽出
  return await page.evaluate((baseUrl) => {
    /**
     * テキストを削除し、空白を整理する関数
     */
    function cleanText(text) {
      if (!text) return '';
      // 改行と余分な空白を整理
      return text.trim()
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n');
    }
    
    /**
     * 要素をマークダウンに変換する関数
     */
    function elementToMarkdown(element, depth = 0) {
      if (!element) return '';
      
      // 非表示要素はスキップ
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return '';
      }
      
      // 要素の種類によって処理を分ける
      const tagName = element.tagName.toLowerCase();
      
      // スキップする要素
      const skipTags = ['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'iframe'];
      if (skipTags.includes(tagName)) {
        return '';
      }
      
      // マークダウンに変換
      let md = '';
      
      switch (tagName) {
        case 'h1':
          return `# ${cleanText(element.textContent)}\n\n`;
        case 'h2':
          return `## ${cleanText(element.textContent)}\n\n`;
        case 'h3':
          return `### ${cleanText(element.textContent)}\n\n`;
        case 'h4':
          return `#### ${cleanText(element.textContent)}\n\n`;
        case 'h5':
          return `##### ${cleanText(element.textContent)}\n\n`;
        case 'h6':
          return `###### ${cleanText(element.textContent)}\n\n`;
        case 'p':
          const text = cleanText(element.textContent);
          return text ? `${text}\n\n` : '';
        case 'ul':
          let ulItems = '';
          Array.from(element.children).forEach(child => {
            if (child.tagName.toLowerCase() === 'li') {
              ulItems += `* ${cleanText(child.textContent)}\n`;
            }
          });
          return ulItems ? `${ulItems}\n` : '';
        case 'ol':
          let olItems = '';
          Array.from(element.children).forEach((child, i) => {
            if (child.tagName.toLowerCase() === 'li') {
              olItems += `${i + 1}. ${cleanText(child.textContent)}\n`;
            }
          });
          return olItems ? `${olItems}\n` : '';
        case 'a':
          const href = element.getAttribute('href');
          if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
            // 相対URLを絶対URLに変換
            const absoluteUrl = new URL(href, baseUrl).href;
            return `[${cleanText(element.textContent)}](${absoluteUrl})`;
          }
          return cleanText(element.textContent);
        case 'img':
          const src = element.getAttribute('src');
          const alt = element.getAttribute('alt') || '';
          if (src) {
            // 相対URLを絶対URLに変換
            const absoluteSrc = new URL(src, baseUrl).href;
            return `![${alt}](${absoluteSrc})`;
          }
          return '';
        case 'code':
        case 'pre':
          return `\`\`\`\n${element.textContent}\n\`\`\`\n\n`;
        case 'blockquote':
          const quote = cleanText(element.textContent);
          return quote
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n') + '\n\n';
        case 'hr':
          return '---\n\n';
        case 'br':
          return '\n';
        case 'table':
          // 表の処理は複雑なので簡略化
          return '[表は省略されました]\n\n';
        case 'div':
        case 'section':
        case 'article':
        case 'main':
        case 'aside':
        case 'header':
        case 'span':
          // コンテナ要素は子要素を再帰的に処理
          let containerMd = '';
          for (const child of element.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE) {
              containerMd += elementToMarkdown(child, depth + 1);
            } else if (child.nodeType === Node.TEXT_NODE) {
              const text = cleanText(child.textContent);
              if (text) containerMd += text + ' ';
            }
          }
          return containerMd;
        default:
          // その他の要素は子要素のみ処理
          if (element.childNodes.length > 0) {
            let result = '';
            for (const child of element.childNodes) {
              if (child.nodeType === Node.ELEMENT_NODE) {
                result += elementToMarkdown(child, depth + 1);
              } else if (child.nodeType === Node.TEXT_NODE) {
                const text = cleanText(child.textContent);
                if (text) result += text + ' ';
              }
            }
            return result;
          }
          // 子要素がなければテキストを返す
          return cleanText(element.textContent);
      }
    }
    
    // ページのメインコンテンツを検出
    let mainElement = document.querySelector('main') ||
                     document.querySelector('article') ||
                     document.querySelector('#content') ||
                     document.querySelector('.content') ||
                     document.querySelector('.main') ||
                     document.body;
    
    // マークダウンに変換
    return elementToMarkdown(mainElement);
  }, baseUrl);
}

/**
 * インデックスマークダウンファイルを作成
 * @param {string} outputDir 出力ディレクトリ
 * @param {Set<string>} visitedUrls 訪問済みURL（フラグメントなし）
 * @param {Map<string, string>} originalUrls オリジナルURLのマッピング
 * @param {Object} metadata メタデータ
 */
async function createIndexMarkdown(outputDir, visitedUrls, originalUrls, metadata) {
  console.log('インデックスページを作成中...');
  
  // インデックスマークダウンを作成
  let markdown = `# スクレイピング結果インデックス

## スクレイピング情報

- **開始URL**: [${metadata.startUrl}](${metadata.startUrl})
- **開始時間**: ${metadata.startTime}
- **最大深度**: ${metadata.maxDepth}
- **処理ページ数**: ${metadata.pagesScraped}
- **マークダウンファイル数**: ${metadata.markdownFiles}

## 取得したページ一覧

`;

  // 訪問済みURLの一覧を追加
  const urls = Array.from(visitedUrls);
  urls.sort();
  
  for (const normalizedUrl of urls) {
    // オリジナルURLを取得（フラグメント付き）
    const originalUrl = originalUrls.get(normalizedUrl) || normalizedUrl;
    
    // URLからファイル名を生成
    const parsedUrl = new URL(normalizedUrl);
    let fileName = parsedUrl.pathname.replace(/\//g, '_').replace(/^_/, '');
    if (!fileName) fileName = 'index';
    if (!fileName.endsWith('.md')) fileName += '.md';
    
    markdown += `- [${originalUrl}](./${fileName})\n`;
  }
  
  // インデックスマークダウンを保存
  fs.writeFileSync(
    path.join(outputDir, 'index.md'),
    markdown
  );
}

// コマンドライン引数から実行
if (require.main === module) {
  const targetUrl = process.argv[2] || 'https://example.com';
  const maxDepth = parseInt(process.argv[3]) || 2;
  
  scrapeToMarkdown(targetUrl, maxDepth).catch(err => {
    console.error('実行エラー:', err);
    process.exit(1);
  });
}

module.exports = { scrapeToMarkdown };
