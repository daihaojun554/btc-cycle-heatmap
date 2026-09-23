'use strict';

/**
 * 给静态资源引用加版本串，避免浏览器长缓存导致更新不生效。
 * GitHub Pages 对静态文件设了 cache-control: max-age=600，
 * 且无法通过响应头覆盖，所以用 ?v=<构建时间> 强制刷新。
 *
 * 幂等：重复运行只会替换已有的版本串。
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const INDEX = path.join(PUBLIC, 'index.html');

function stamp(version = Date.now().toString(36)) {
  let html = fs.readFileSync(INDEX, 'utf8');
  const before = html;

  // 先移除旧的版本串，再统一加上新的
  html = html.replace(/\.\/(style\.css|app\.js)(\?v=[^"']*)?/g, (m, file) => `./${file}?v=${version}`);

  if (html !== before) {
    fs.writeFileSync(INDEX, html);
    return { changed: true, version };
  }
  return { changed: false, version };
}

module.exports = { stamp };

if (require.main === module) {
  const r = stamp(process.argv[2]);
  console.log(r.changed ? `✓ 资源版本串已更新为 v=${r.version}` : '资源版本串无变化');
}
