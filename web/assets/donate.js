/* Voxian donate widget: amount selection for USDC / SOL (Solana Pay) and GitHub Sponsors.
 * Plain script, no build step. Shared by the demo app (web/) and the landing page (site/).
 * Usage: <div data-donate-widget></div> + <script src="assets/vendor/qrcode.js"></script> + this file,
 * or call window.VoxianDonate.mount(element) for content rendered later (the app's #donate view). */
(function () {
  'use strict';

  var CONFIG = {
    address: '5g4xQALSN81J1EseRkkb4GGWJiLAJCPRnoqUeB5jYWkk',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC on Solana mainnet
    sponsors: 'https://github.com/sponsors/neroiq-47',
    label: 'Voxian Chain',
    message: 'Donation to Voxian Chain: security reviews and testnet',
  };

  var USD_PRESETS = [
    { amount: 5, tier: 'Supporter' }, { amount: 25, tier: 'Builder' }, { amount: 100, tier: 'Agent Pioneer' },
    { amount: 500, tier: 'Validator Partner' }, { amount: 2500, tier: 'Enterprise' }, { amount: 10000, tier: 'Enterprise Partner' },
  ];
  var SOL_PRESETS = [{ amount: 0.1 }, { amount: 0.5 }, { amount: 1 }, { amount: 5 }, { amount: 25 }, { amount: 100 }];
  var METHODS = {
    usdc: { label: 'USDC', sub: 'Solana', unit: 'USDC', decimals: 6, presets: USD_PRESETS, prefix: '$' },
    sol: { label: 'SOL', sub: 'Solana', unit: 'SOL', decimals: 9, presets: SOL_PRESETS, prefix: '' },
    github: { label: 'GitHub', sub: 'Sponsors', unit: 'USD', decimals: 0, presets: USD_PRESETS, prefix: '$' },
  };
  var MAX_AMOUNT = 1000000;

  var CSS = '' +
    '.vd{border:1px solid #b65cff55;background:linear-gradient(145deg,#b65cff12,#0d0b0e 60%);padding:22px;position:relative;color:#f4f0f5;font-family:Inter,Arial,sans-serif}' +
    '.vd:before{content:"";position:absolute;left:0;top:0;width:35px;height:2px;background:#b65cff;box-shadow:0 0 12px #b65cff66}' +
    '.vd *{box-sizing:border-box}.vd-k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;font-weight:900;color:#b65cff;margin:0 0 10px}' +
    '.vd-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:22px;align-items:start}' +
    '.vd-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:18px}' +
    '.vd-seg button,.vd-amts button,.vd-freq button{font:inherit;cursor:pointer;background:#0d0b0e;color:#d9cfe0;border:1px solid #302337;border-radius:3px;padding:10px 8px;text-align:center;transition:.15s}' +
    '.vd-seg button b{display:block;font-size:13px;letter-spacing:.06em}.vd-seg button span{display:block;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#a7a0ab}' +
    '.vd-seg button[aria-pressed=true],.vd-amts button[aria-pressed=true],.vd-freq button[aria-pressed=true]{border-color:#b65cff;background:#b65cff1f;color:#fff;box-shadow:0 0 18px #a83cff25}' +
    '.vd-seg button:hover,.vd-amts button:hover,.vd-freq button:hover{border-color:#b65cff99}' +
    '.vd-amts{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.vd-amts button b{display:block;font-size:17px;font-weight:900;letter-spacing:-.03em}.vd-amts button span{display:block;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#a7a0ab;min-height:11px}' +
    '.vd-custom{display:flex;align-items:stretch;margin-top:8px;border:1px solid #302337;border-radius:3px;background:#09070b}.vd-custom:focus-within{border-color:#b65cff;box-shadow:0 0 0 3px #b65cff26}' +
    '.vd-custom span{padding:11px 0 11px 12px;color:#a7a0ab;font-weight:800;font-size:13px}.vd-custom input{flex:1;min-width:0;background:transparent;border:0;color:#fff;font:inherit;font-size:15px;padding:11px 12px;outline:0}.vd-custom em{font-style:normal;padding:11px 12px;color:#a7a0ab;font-size:11px;letter-spacing:.14em;font-weight:800}' +
    '.vd-freq{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:14px}.vd-freq button{font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:800}' +
    '.vd-err{color:#ff6b8b;font-size:12px;min-height:18px;margin-top:6px}.vd-hint{font-size:12px;color:#a7a0ab;margin-top:2px}' +
    '.vd-sum{border:1px solid #302337;background:#09070b;padding:16px;text-align:center}.vd-total{font-size:30px;font-weight:900;letter-spacing:-.05em;line-height:1.05}.vd-total small{font-size:12px;color:#a7a0ab;letter-spacing:.1em;font-weight:800;margin-left:4px}' +
    '.vd-net{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#d9a8ff;margin:6px 0 12px}' +
    '.vd-qr{background:#f4f0f5;padding:10px;width:min(220px,100%);margin:0 auto 12px;border-radius:3px;line-height:0}.vd-qr svg{width:100%;height:auto;display:block}' +
    '.vd-actions{display:grid;gap:7px}.vd-btn{display:flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:12px 14px;border-radius:3px;border:1px solid #b65cff66;background:transparent;color:#f4f0f5;cursor:pointer;text-decoration:none;transition:.2s}' +
    '.vd-btn:hover{border-color:#b65cff;box-shadow:0 0 22px #a83cff30;transform:translateY(-1px);color:#fff}.vd-btn.vd-primary{background:#b65cff;border-color:#b65cff;color:#100814}' +
    '.vd-btn[aria-disabled=true]{opacity:.45;pointer-events:none}.vd-row{display:grid;grid-template-columns:1fr 1fr;gap:7px}' +
    '.vd-addr{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;word-break:break-all;color:#e8d5ff;border:1px dashed #302337;padding:8px;margin:10px 0 0;cursor:pointer;text-align:left}' +
    '.vd-status{font-size:11px;letter-spacing:.08em;color:#6ee7a8;min-height:16px;margin-top:6px;text-align:center}' +
    '.vd-note{font-size:11px;color:#7e7585;margin:14px 0 0}' +
    '.vd :focus-visible{outline:2px solid #b65cff;outline-offset:2px}' +
    '.vd-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '@media(max-width:760px){.vd-grid{grid-template-columns:1fr}.vd-amts{grid-template-columns:repeat(2,1fr)}}';

  function injectCss() {
    if (document.getElementById('vd-css')) return;
    var s = document.createElement('style');
    s.id = 'vd-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function fmt(n, method) {
    var m = METHODS[method];
    var opts = { maximumFractionDigits: m.decimals, minimumFractionDigits: 0 };
    return m.prefix + Number(n).toLocaleString('en-US', opts);
  }

  // Parse a user-typed amount without floating-point surprises. Returns { value: Number, text } or { error }.
  function parseAmount(raw, method) {
    var m = METHODS[method];
    var s = String(raw || '').trim().replace(/[$\s]/g, '');
    if (!s) return { error: 'Choose or enter an amount.' };
    // Commas are accepted only as thousands separators; "0,5" must not be read as 5.
    if (s.indexOf(',') !== -1) {
      if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return { error: 'Use a dot for decimals, like 0.5. Commas are only for thousands, like 1,000.' };
      s = s.replace(/,/g, '');
    }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { error: 'Enter a number, like 25 or 0.5.' };
    if (s.charAt(0) === '.') s = '0' + s;
    if (s.charAt(s.length - 1) === '.') s = s.slice(0, -1); // "5." while typing means 5
    var parts = s.split('.');
    if (parts[1] && parts[1].length > m.decimals) {
      return { error: m.decimals === 0 ? 'GitHub Sponsors takes whole dollars.' : m.unit + ' supports up to ' + m.decimals + ' decimals.' };
    }
    var v = Number(s);
    if (!(v > 0)) return { error: 'The amount must be more than zero.' };
    if (method === 'github' && v < 1) return { error: 'GitHub Sponsors minimum is $1.' };
    if (v > MAX_AMOUNT) return { error: 'For gifts above ' + fmt(MAX_AMOUNT, method) + ', please get in touch through GitHub.' };
    var text = parts[0].replace(/^0+(?=\d)/, '') + (parts[1] ? '.' + parts[1].replace(/0+$/, '') : '');
    if (text.endsWith('.')) text = text.slice(0, -1);
    return { value: v, text: text };
  }

  // Solana Pay transfer request: solana:<recipient>?amount=&spl-token=&label=&message=
  function solanaPayUrl(method, amountText) {
    var q = ['amount=' + amountText];
    if (method === 'usdc') q.push('spl-token=' + CONFIG.usdcMint);
    q.push('label=' + encodeURIComponent(CONFIG.label));
    q.push('message=' + encodeURIComponent(CONFIG.message));
    return 'solana:' + CONFIG.address + '?' + q.join('&');
  }

  // GitHub only documents metadata_* parameters; amount/frequency are passed as a convenience
  // (GitHub ignores what it doesn't use) and the donor confirms the amount on GitHub.
  function sponsorsUrl(amountText, frequency) {
    return CONFIG.sponsors + '/sponsorships?amount=' + amountText + '&frequency=' + (frequency === 'monthly' ? 'recurring' : 'one-time') +
      '&metadata_source=voxian-site&metadata_amount=' + amountText + '&metadata_frequency=' + frequency;
  }

  function qrSvg(text) {
    if (typeof window.qrcode !== 'function') return '';
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var path = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) if (qr.isDark(r, c)) path += 'M' + c + ' ' + r + 'h1v1h-1z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ' + (n + 4) + ' ' + (n + 4) + '" shape-rendering="crispEdges" role="img" aria-label="Solana Pay QR code">' +
      '<rect x="-2" y="-2" width="' + (n + 4) + '" height="' + (n + 4) + '" fill="#f4f0f5"/><path d="' + path + '" fill="#080708"/></svg>';
  }

  function tierFor(v) {
    var t = null;
    USD_PRESETS.forEach(function (p) { if (v >= p.amount) t = p.tier; });
    return t;
  }

  function copyText(text, el, status) {
    function done(msg) { status.textContent = msg; clearTimeout(status._t); status._t = setTimeout(function () { status.textContent = ''; }, 2600); }
    function fallback() {
      if (el) { var r = document.createRange(); r.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
      var ok = false;
      try { ok = el ? document.execCommand('copy') : false; } catch (e) { ok = false; }
      if (ok) return done('Copied');
      if (!el) {
        // Nothing on the page to select: let the donor copy the text from a prompt.
        window.prompt('Copy this text', text);
        return done('');
      }
      done('Selected: press Ctrl+C / ⌘C to copy');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done('Copied'); }, fallback);
    else fallback();
  }

  function mount(root) {
    if (!root || root.__vd) return;
    root.__vd = true;
    injectCss();
    var state = { method: root.getAttribute('data-method') || 'usdc', amountText: '25', preset: 25, frequency: 'one-time' };

    function current() {
      var parsed = parseAmount(state.amountText, state.method);
      var valid = !parsed.error;
      var isCrypto = state.method !== 'github';
      var payUrl = valid ? (isCrypto ? solanaPayUrl(state.method, parsed.text) : sponsorsUrl(parsed.text, state.frequency)) : '';
      return { m: METHODS[state.method], parsed: parsed, valid: valid, isCrypto: isCrypto, payUrl: payUrl };
    }

    // The summary/QR/actions column. Rebuilt on every amount change; the inputs on the left are not,
    // so typing never loses focus and assistive tech isn't flooded with re-inserted regions.
    function summaryHtml(c) {
      var m = c.m, parsed = c.parsed;
      var tier = c.valid && state.method === 'github' && state.frequency === 'monthly' ? tierFor(parsed.value) : null;
      var html = '';
      if (c.valid) {
        html += '<div class="vd-total">' + esc(c.isCrypto ? Number(parsed.text).toLocaleString('en-US', { maximumFractionDigits: m.decimals }) : fmt(parsed.value, 'github')) + '<small>' + m.unit + (state.method === 'github' && state.frequency === 'monthly' ? ' / month' : '') + '</small></div>' +
          '<div class="vd-net">' + (c.isCrypto ? 'Solana mainnet' : 'GitHub Sponsors · ' + state.frequency) + (tier ? ' · ' + esc(tier) + ' tier' : '') + '</div>';
      } else {
        html += '<div class="vd-total" style="color:#7e7585">—</div><div class="vd-net">Choose an amount</div>';
      }
      if (c.isCrypto) {
        html += (c.valid ? '<div class="vd-qr">' + qrSvg(c.payUrl) + '</div>' : '') +
          '<div class="vd-actions"><a class="vd-btn vd-primary" data-act="pay" href="' + esc(c.payUrl || '#') + '" aria-disabled="' + !c.valid + '">Open in wallet</a>' +
          '<div class="vd-row"><button type="button" class="vd-btn" data-act="copy-link"' + (c.valid ? '' : ' aria-disabled="true"') + '>Copy pay link</button>' +
          '<button type="button" class="vd-btn" data-act="copy-addr">Copy address</button></div></div>' +
          '<div class="vd-addr" tabindex="0" role="button" aria-label="Donation address, press Enter to copy" data-act="copy-addr">' + CONFIG.address + '</div>' +
          '<div class="vd-status" aria-live="polite"></div>' +
          '<p class="vd-hint">Scan with Phantom, Solflare or any Solana Pay wallet, or tap Open in wallet on your phone. ' +
          (state.method === 'usdc' ? 'USDC (SPL) only.' : 'Native SOL.') + ' Transfers cannot be reversed.</p>';
      } else {
        html += '<div class="vd-actions"><a class="vd-btn vd-primary" data-act="pay" href="' + esc(c.payUrl || '#') + '" target="_blank" rel="noopener" aria-disabled="' + !c.valid + '">Continue on GitHub ↗</a></div>' +
          '<p class="vd-hint">You confirm the amount on GitHub. Card and PayPal are accepted there, and GitHub takes no fee on personal accounts.</p>';
      }
      return html;
    }

    function update() {
      var c = current();
      root.querySelector('.vd-sum').innerHTML = summaryHtml(c);
      var err = root.querySelector('.vd-err');
      var msg = c.valid ? '' : c.parsed.error;
      if (err.textContent !== msg) err.textContent = msg; // live region: announced only when it changes
      var sr = root.querySelector('.vd-sr');
      var said = c.valid ? c.parsed.text + ' ' + c.m.unit + (c.isCrypto ? ' on Solana' : ' via GitHub Sponsors, ' + state.frequency) : '';
      if (sr.textContent !== said) sr.textContent = said;
      var btns = root.querySelectorAll('.vd-amts button');
      for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(state.preset === Number(btns[i].dataset.amount)));
      root.__payUrl = c.payUrl;
    }

    function render() {
      var m = METHODS[state.method];
      var html = '<div class="vd" role="group" aria-label="Donate to Voxian">' +
        '<div class="vd-grid"><div>' +
        '<p class="vd-k">1 · Pay with</p><div class="vd-seg" role="group" aria-label="Payment method">';
      Object.keys(METHODS).forEach(function (k) {
        html += '<button type="button" data-method="' + k + '" aria-pressed="' + (state.method === k) + '"><b>' + METHODS[k].label + '</b><span>' + METHODS[k].sub + '</span></button>';
      });
      html += '</div><p class="vd-k">2 · Amount' + (state.method === 'sol' ? ' (SOL)' : ' (USD)') + '</p><div class="vd-amts" role="group" aria-label="Preset amounts">';
      m.presets.forEach(function (p) {
        html += '<button type="button" data-amount="' + p.amount + '" aria-pressed="false"><b>' + esc(fmt(p.amount, state.method)) + '</b><span>' + esc(p.tier || '') + '</span></button>';
      });
      html += '</div><label class="vd-custom"><span>' + (m.prefix || '◎') + '</span><input type="text" inputmode="decimal" autocomplete="off" aria-label="Custom amount in ' + m.unit + '" placeholder="Custom amount" value="' + esc(state.preset === null ? state.amountText : '') + '"><em>' + m.unit + '</em></label>' +
        '<div class="vd-err" aria-live="polite"></div>';
      if (state.method === 'github') {
        html += '<p class="vd-k" style="margin-top:6px">3 · Frequency</p><div class="vd-freq" role="group" aria-label="Frequency">' +
          '<button type="button" data-freq="one-time" aria-pressed="' + (state.frequency === 'one-time') + '">One-time</button>' +
          '<button type="button" data-freq="monthly" aria-pressed="' + (state.frequency === 'monthly') + '">Monthly</button></div>';
      }
      html += '</div><div class="vd-sum"></div></div><div class="vd-sr" aria-live="polite"></div>' +
        '<p class="vd-note">Donations are gifts to open-source development: not an investment or a token sale, and they don\'t buy or reserve any VOX.</p></div>';
      root.innerHTML = html;
      update();
    }

    root.addEventListener('click', function (e) {
      var t = e.target.closest('button, [data-act]');
      if (!t || !root.contains(t)) return;
      if (t.dataset.method) {
        var from = state.method, to = t.dataset.method;
        if (from === to) return;
        state.method = to;
        if (from === 'sol' || to === 'sol') { state.preset = to === 'sol' ? 1 : 25; state.amountText = String(state.preset); }
        // USDC <-> GitHub are both USD: keep what the donor chose.
        return render();
      }
      if (t.dataset.amount) {
        state.preset = Number(t.dataset.amount);
        state.amountText = t.dataset.amount;
        root.querySelector('.vd-custom input').value = '';
        return update();
      }
      if (t.dataset.freq) { state.frequency = t.dataset.freq; return render(); }
      var status = root.querySelector('.vd-status');
      if (t.dataset.act === 'copy-addr') { e.preventDefault(); copyText(CONFIG.address, root.querySelector('.vd-addr'), status); }
      if (t.dataset.act === 'copy-link' && root.__payUrl) { e.preventDefault(); copyText(root.__payUrl, null, status); }
      if (t.dataset.act === 'pay' && !root.__payUrl) { e.preventDefault(); return; }
      if (t.dataset.act === 'pay' && state.method !== 'github') {
        var startedHidden = false;
        var onVis = function () { if (document.visibilityState === 'hidden') startedHidden = true; };
        document.addEventListener('visibilitychange', onVis);
        setTimeout(function () {
          document.removeEventListener('visibilitychange', onVis);
          var st = root.querySelector('.vd-status');
          if (!startedHidden && st) st.textContent = 'No wallet opened? Scan the QR code with your phone, or copy the pay link.';
        }, 1500);
      }
    });
    root.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('vd-addr')) { e.preventDefault(); copyText(CONFIG.address, e.target, root.querySelector('.vd-status')); }
    });
    root.addEventListener('input', function (e) {
      if (!e.target.matches('.vd-custom input')) return;
      state.amountText = e.target.value;
      state.preset = null;
      update();
    });
    render();
  }

  function mountAll() {
    var nodes = document.querySelectorAll('[data-donate-widget]');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  window.VoxianDonate = { mount: mount, mountAll: mountAll, parseAmount: parseAmount, solanaPayUrl: solanaPayUrl, sponsorsUrl: sponsorsUrl, config: CONFIG };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
})();
