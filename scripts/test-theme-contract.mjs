import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code=readFileSync(new URL('../public/theme.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
const base=Object.fromEntries([...css.matchAll(/^  (--[a-z-]+): (#[0-9a-f]{6});/gm)].slice(0,20).map(m=>[m[1],m[2]]));
function tokens(theme){
 const root=css.slice(css.indexOf(':root {'),css.indexOf(':root[data-theme="light"]'));
 const values=Object.fromEntries([...root.matchAll(/(--[a-z-]+): (#[0-9a-f]{6});/g)].map(m=>[m[1],m[2]]));
 const block=css.match(new RegExp(':root\\[data-theme="'+theme+'"\\] \\{([^}]+)'))?.[1]||'';
 return {...values,...Object.fromEntries([...block.matchAll(/(--[a-z-]+): (#[0-9a-f]{6});/g)].map(m=>[m[1],m[2]]))};
}
function luminance(hex){const rgb=hex.match(/[0-9a-f]{2}/g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a,b){let x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
for(const theme of ['dark','light','contrast']){
 const values=tokens(theme);
 for(const ink of ['--ink','--dim','--accent'])for(const ground of ['--bg','--bg-raised','--bg-strong'])assert.ok(contrast(values[ink],values[ground])>=4.5,`${theme} ${ink}/${ground} contrast`);
 for(const ground of ['--bg','--bg-raised','--bg-strong'])assert.ok(contrast(values['--line'],values[ground])>=3,`${theme} control boundaries`);
 assert.ok(contrast(values['--accent-ink'],values['--accent'])>=4.5,`${theme} filled control`);
 assert.ok(contrast(values['--accent-ink'],values['--accent-hover'])>=4.5,`${theme} hover control`);
 if(theme==='contrast')assert.ok(contrast(values['--ink'],values['--bg'])>=15);
 console.log(theme,'body',contrast(values['--ink'],values['--bg']).toFixed(2),'secondary',contrast(values['--dim'],values['--bg']).toFixed(2));
}
for(const preset of [null,'dark','light','contrast','invalid']){
 const select={value:'',addEventListener:(name,cb)=>{select.change=cb}};
 const root={dataset:{},style:{}};let load,stored;
 const context=vm.createContext({localStorage:{getItem:()=>preset,setItem:(_k,v)=>{stored=v}},document:{documentElement:root,getElementById:()=>select,addEventListener:(_e,cb)=>{load=cb}},window:{matchMedia:()=>({matches:false}),dispatchEvent(){}},CustomEvent:class {constructor(name,options){this.type=name;this.detail=options.detail}}});
 vm.runInContext(code,context);load();
 assert.equal(root.dataset.theme,['dark','light','contrast'].includes(preset)?preset:'light');
 select.value='contrast';select.change();assert.equal(root.dataset.theme,'contrast');assert.equal(stored,'contrast');
}
const restricted=vm.createContext({localStorage:{getItem(){throw Error('blocked')}},document:{documentElement:{dataset:{},style:{}},getElementById:()=>null,addEventListener(){}},window:{matchMedia:query=>({matches:query.includes('prefers-contrast')}),dispatchEvent(){}},CustomEvent:class {}});
vm.runInContext(code,restricted);
assert.equal(restricted.document.documentElement.dataset.theme,'contrast');
console.log('PASS theme contract: all text/control contrasts, three theme choices, preference persistence, invalid preference, inaccessible storage, system high contrast');
