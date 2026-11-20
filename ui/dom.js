// Flicker-free DOM updates: change only the nodes that differ from the new HTML.
//
// Replacing innerHTML on every live update recreates every element, so CSS entrance animations
// replay (the "flash" on the Run screen), open <details> fold back, text selections are lost and
// scroll positions jump. morph() keeps every node that is still the same and only touches the
// differences. It never changes a <details>' open state (the user's choice) or the value of the
// input that has the focus.

/** Make `el`'s children match `html`. */
export function morph(el, html) {
  if (!el) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}

/** Make element `el` itself (tag kept) match the single root element of `html`. */
export function morphElement(el, html) {
  if (!el) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const next = tpl.content.firstElementChild;
  if (!next) return el;
  if (next.nodeName !== el.nodeName) {
    el.replaceWith(next);
    return next;
  }
  syncAttributes(el, next);
  morphChildren(el, next);
  return el;
}

function morphChildren(a, b) {
  const want = [...b.childNodes];
  let have = [...a.childNodes];
  for (let i = 0; i < want.length; i++) {
    const y = want[i];
    const x = have[i];
    if (!x) {
      a.appendChild(y);
      continue;
    }
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName || keyOf(x) !== keyOf(y)) {
      // A keyed child that moved: reuse it from later in the list instead of rebuilding it.
      const k = keyOf(y);
      const moved = k ? have.slice(i + 1).find((n) => keyOf(n) === k) : null;
      if (moved) {
        a.insertBefore(moved, x);
        have = [...a.childNodes];
        morphNode(moved, y);
      } else {
        a.insertBefore(y, x);
        have = [...a.childNodes];
      }
      continue;
    }
    morphNode(x, y);
  }
  for (const extra of [...a.childNodes].slice(want.length)) extra.remove();
}

function morphNode(x, y) {
  if (x.nodeType === 3 || x.nodeType === 8) {
    if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
    return;
  }
  if (x.nodeType !== 1) return;
  if (x.isEqualNode(y)) return;
  syncAttributes(x, y);
  morphChildren(x, y);
}

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') || n.id || '' : '');

function syncAttributes(x, y) {
  for (const { name } of [...x.attributes]) {
    if (name === 'open' && x.nodeName === 'DETAILS') continue;
    if (!y.hasAttribute(name)) x.removeAttribute(name);
  }
  for (const { name, value } of [...y.attributes]) {
    if (name === 'open' && x.nodeName === 'DETAILS') continue;
    if (x.getAttribute(name) !== value) x.setAttribute(name, value);
  }
  // A fresh <details open> from the new HTML is respected only when it just appeared (handled by
  // insertion); an existing one keeps what the user chose.
  if ((x.nodeName === 'INPUT' || x.nodeName === 'TEXTAREA' || x.nodeName === 'SELECT') && document.activeElement !== x && 'value' in y && x.value !== y.value) {
    x.value = y.value;
  }
}
