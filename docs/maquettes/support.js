/* MAAQ — runtime générique pour les maquettes exportées du canvas Claude Design.
   Interprète les gabarits <x-dc> (sc-if / sc-for / {{bindings}}) et le composant
   déclaré dans le <script type="text/x-dc" data-dc-script data-props="..."> associé,
   sans dépendre de l'outil Claude Design. */
(function () {
  'use strict';

  class DCLogic {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(patch) {
      this.state = Object.assign({}, this.state, patch);
      if (this._onChange) this._onChange();
    }
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var BINDING_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE_BINDING_RE = /^\{\{\s*([^}]+?)\s*\}\}$/;

  function resolvePath(path, ctx) {
    var parts = path.split('.');
    var obj = Object.prototype.hasOwnProperty.call(ctx.scopes, parts[0]) ? ctx.scopes[parts[0]] : ctx.bindings[parts[0]];
    for (var i = 1; i < parts.length && obj !== null && obj !== undefined; i++) obj = obj[parts[i]];
    return obj;
  }

  function resolveTemplateString(str, ctx) {
    return str.replace(BINDING_RE, function (_, path) {
      var v = resolvePath(path, ctx);
      return v === null || v === undefined ? '' : String(v);
    });
  }

  function compile(node, isSvg) {
    if (node.nodeType === Node.TEXT_NODE) {
      var raw = node.nodeValue;
      var liveText = document.createTextNode(raw.indexOf('{{') === -1 ? raw : '');
      var needsUpdate = raw.indexOf('{{') !== -1;
      return {
        liveNode: liveText,
        update: needsUpdate ? function (ctx) {
          var next = resolveTemplateString(raw, ctx);
          if (liveText.nodeValue !== next) liveText.nodeValue = next;
        } : function () {},
      };
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return { liveNode: document.createComment(''), update: function () {} };
    }

    var tag = node.tagName.toLowerCase();
    var svgHere = isSvg || tag === 'svg';

    if (tag === 'sc-if') {
      var condAttr = node.getAttribute('value') || '';
      var m = condAttr.match(WHOLE_BINDING_RE);
      var condPath = m ? m[1] : null;
      var wrap = document.createElement('sc-if');
      var kids = [];
      node.childNodes.forEach(function (c) { kids.push(compile(c, svgHere)); });
      kids.forEach(function (k) { wrap.appendChild(k.liveNode); });
      return {
        liveNode: wrap,
        update: function (ctx) {
          var cond = condPath ? !!resolvePath(condPath, ctx) : false;
          wrap.style.display = cond ? '' : 'none';
          kids.forEach(function (k) { k.update(ctx); });
        },
      };
    }

    if (tag === 'sc-for') {
      var listAttr = node.getAttribute('list') || '';
      var lm = listAttr.match(WHOLE_BINDING_RE);
      var listPath = lm ? lm[1] : null;
      var alias = node.getAttribute('as');
      var wrapFor = document.createElement('sc-for');
      var templateChildren = [];
      node.childNodes.forEach(function (c) { templateChildren.push(c); });
      var rows = [];
      return {
        liveNode: wrapFor,
        update: function (ctx) {
          var list = (listPath ? resolvePath(listPath, ctx) : []) || [];
          var i;
          for (i = 0; i < list.length; i++) {
            var itemCtx = { bindings: ctx.bindings, scopes: Object.assign({}, ctx.scopes) };
            itemCtx.scopes[alias] = list[i];
            if (i < rows.length) {
              rows[i].forEach(function (c) { c.update(itemCtx); });
            } else {
              var compiledRow = templateChildren.map(function (tpl) { return compile(tpl, svgHere); });
              compiledRow.forEach(function (c) { wrapFor.appendChild(c.liveNode); });
              compiledRow.forEach(function (c) { c.update(itemCtx); });
              rows.push(compiledRow);
            }
          }
          while (rows.length > list.length) {
            var removed = rows.pop();
            removed.forEach(function (c) { wrapFor.removeChild(c.liveNode); });
          }
        },
      };
    }

    // <tr data-sc-for-list="{{x}}" data-sc-for-as="y"> — table rows can't keep a
    // wrapping <sc-for> (the HTML table parser strips/relocates unknown elements
    // inside <tbody>), so the loop is carried on the <tr> itself instead.
    if (tag === 'tr' && node.hasAttribute('data-sc-for-list')) {
      var tblListPath = (node.getAttribute('data-sc-for-list') || '').match(WHOLE_BINDING_RE);
      tblListPath = tblListPath ? tblListPath[1] : null;
      var tblAlias = node.getAttribute('data-sc-for-as');
      var tblTemplateAttrs = [];
      Array.prototype.forEach.call(node.attributes, function (attr) {
        if (attr.name.indexOf('data-sc-for-') === 0) return;
        tblTemplateAttrs.push(attr);
      });
      var tblChildren = [];
      node.childNodes.forEach(function (c) { tblChildren.push(c); });
      // A zero-footprint <tr> anchor keeps a stable, valid position inside
      // <tbody>; real rows are inserted as its preceding siblings.
      var anchor = document.createElement('tr');
      anchor.style.display = 'none';
      var tblRows = [];
      return {
        liveNode: anchor,
        update: function (ctx) {
          var list = (tblListPath ? resolvePath(tblListPath, ctx) : []) || [];
          var i;
          for (i = 0; i < list.length; i++) {
            var itemCtx = { bindings: ctx.bindings, scopes: Object.assign({}, ctx.scopes) };
            itemCtx.scopes[tblAlias] = list[i];
            if (i < tblRows.length) {
              tblRows[i].update(itemCtx);
            } else {
              var tr = document.createElement('tr');
              tblTemplateAttrs.forEach(function (attr) {
                if (attr.value.indexOf('{{') === -1) tr.setAttribute(attr.name, attr.value);
              });
              var kids = tblChildren.map(function (c) { return compile(c, svgHere); });
              kids.forEach(function (k) { tr.appendChild(k.liveNode); });
              var rowObj = {
                el: tr,
                update: function (c) { kids.forEach(function (k) { k.update(c); }); },
              };
              anchor.parentNode.insertBefore(tr, anchor);
              tblRows.push(rowObj);
              rowObj.update(itemCtx);
            }
          }
          while (tblRows.length > list.length) {
            var removedRow = tblRows.pop();
            removedRow.el.remove();
          }
        },
      };
    }

    var live = svgHere ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    var dynamicAttrs = [];
    Array.prototype.forEach.call(node.attributes, function (attr) {
      var name = attr.name;
      var value = attr.value;
      if (value.indexOf('{{') === -1) {
        live.setAttribute(name, value);
        return;
      }
      var whole = value.match(WHOLE_BINDING_RE);
      var path = whole ? whole[1] : null;
      if (name === 'value' && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
        dynamicAttrs.push(function (ctx) {
          var v = path ? resolvePath(path, ctx) : resolveTemplateString(value, ctx);
          var s = v === null || v === undefined ? '' : v;
          if (live.value !== s) live.value = s;
        });
      } else if (name === 'onclick' || name === 'oninput') {
        var prop = name;
        dynamicAttrs.push(function (ctx) {
          var fn = path ? resolvePath(path, ctx) : undefined;
          live[prop] = typeof fn === 'function' ? fn : null;
        });
      } else {
        dynamicAttrs.push(function (ctx) {
          var s = resolveTemplateString(value, ctx);
          if (live.getAttribute(name) !== s) live.setAttribute(name, s);
        });
      }
    });

    var kids2 = [];
    node.childNodes.forEach(function (c) {
      var k = compile(c, svgHere);
      live.appendChild(k.liveNode);
      kids2.push(k);
    });

    return {
      liveNode: live,
      update: function (ctx) {
        dynamicAttrs.forEach(function (u) { u(ctx); });
        kids2.forEach(function (k) { k.update(ctx); });
      },
    };
  }

  function buildTweaksPanel(schema, props, onChange) {
    var keys = Object.keys(schema).filter(function (k) { return k !== '$preview' && schema[k] && schema[k].editor; });
    if (!keys.length) return null;

    var panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;font-family:Karla,sans-serif;';

    var toggle = document.createElement('button');
    toggle.textContent = '⚙ Tweaks';
    toggle.style.cssText = 'background:#2B211F;color:#F7F1E6;border:none;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);';
    panel.appendChild(toggle);

    var box = document.createElement('div');
    box.style.cssText = 'display:none;margin-top:8px;background:#F6F0E4;border:1px solid #DDCFC0;border-radius:10px;padding:14px;max-width:280px;max-height:70vh;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.2);';
    panel.appendChild(box);

    var bySection = {};
    keys.forEach(function (k) {
      var sec = schema[k].section || 'Réglages';
      (bySection[sec] = bySection[sec] || []).push(k);
    });

    Object.keys(bySection).forEach(function (sec) {
      var h = document.createElement('div');
      h.textContent = sec;
      h.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6E5F58;margin:10px 0 6px;';
      box.appendChild(h);

      bySection[sec].forEach(function (k) {
        var def = schema[k];
        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:#2B211F;margin-bottom:8px;';
        var span = document.createElement('span');
        span.textContent = k;
        row.appendChild(span);

        if (def.editor === 'boolean') {
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!props[k];
          cb.onchange = function () { props[k] = cb.checked; onChange(); };
          row.appendChild(cb);
        } else if (def.editor === 'enum') {
          var sel = document.createElement('select');
          sel.style.cssText = 'font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid #DDCFC0;';
          (def.options || []).forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (opt === props[k]) o.selected = true;
            sel.appendChild(o);
          });
          sel.onchange = function () { props[k] = sel.value; onChange(); };
          row.appendChild(sel);
        }
        box.appendChild(row);
      });
    });

    toggle.onclick = function () { box.style.display = box.style.display === 'none' ? 'block' : 'none'; };
    return panel;
  }

  function boot() {
    var xdc = document.querySelector('x-dc');
    var scriptEl = document.querySelector('script[data-dc-script]');
    if (!xdc || !scriptEl) return;

    var schema = {};
    try { schema = JSON.parse(scriptEl.getAttribute('data-props') || '{}'); } catch (e) { schema = {}; }

    var props = {};
    Object.keys(schema).forEach(function (k) {
      if (k === '$preview') return;
      if (schema[k] && ('default' in schema[k])) props[k] = schema[k].default;
    });

    var preview = schema.$preview || { width: 390, height: 844 };
    var style = document.createElement('style');
    if (preview.width && preview.width <= 600) {
      style.textContent = 'x-dc,sc-if,sc-for{display:contents;}' +
        'html,body{margin:0;}' +
        'body{background:#00000010;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;min-height:100vh;}' +
        'x-dc>div:first-child{border-radius:28px;box-shadow:0 20px 60px rgba(43,33,31,0.25);}';
    } else {
      style.textContent = 'x-dc,sc-if,sc-for{display:contents;}' +
        'html,body{margin:0;height:100%;}' +
        'body{display:flex;min-height:100vh;}';
    }
    document.head.appendChild(style);

    var compiled = compile(xdc, false);
    xdc.replaceWith(compiled.liveNode);

    var factory = new Function('DCLogic', scriptEl.textContent + '\nreturn Component;');
    var ComponentClass = factory(DCLogic);
    var instance = new ComponentClass(props);

    function render() {
      var bindings = instance.renderVals();
      compiled.update({ bindings: bindings, scopes: {} });
    }
    instance._onChange = render;
    render();

    var panel = buildTweaksPanel(schema, props, render);
    if (panel) document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
