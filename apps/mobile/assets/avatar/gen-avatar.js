const fs=require('fs');
const C={asph:'#26262A',asph2:'#1B1B1E',tire:'#151517',side:'#2E2E33',y:'#FFC629',yd:'#E5A400',yl:'#FFE27A',ink:'#141416',blush:'#FF8A5C'};
// tread blocks
let tread='';
for(let i=0;i<20;i++){const a=i*18;tread+=`<rect x="-13" y="-160" width="26" height="22" rx="6" fill="${C.tire}" transform="rotate(${a})"/>`;}
// rim holes
let holes='';
for(let i=0;i<5;i++){const a=i*72;holes+=`<path d="M -20 -94 Q 0 -104 20 -94 L 13 -70 Q 0 -75 -13 -70 Z" fill="${C.asph2}" transform="rotate(${a})"/>`;}
// lug nuts
let nuts='';
for(let i=0;i<5;i++){const a=i*72+36;const r=78, x=(r*Math.sin(a*Math.PI/180)).toFixed(1), y=(-r*Math.cos(a*Math.PI/180)).toFixed(1);nuts+=`<circle cx="${x}" cy="${y}" r="6" fill="${C.yd}"/><circle cx="${x}" cy="${y}" r="2.6" fill="${C.yl}"/>`;}
// asphalt speckles (deterministic)
let sp='';let s=7;const rnd=()=>{s=(s*16807)%2147483647;return s/2147483647};
for(let i=0;i<90;i++){const a=rnd()*Math.PI*2,r=Math.sqrt(rnd())*250;const x=256+r*Math.cos(a),y=256+r*Math.sin(a);sp+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.8+rnd()*1.8).toFixed(1)}" fill="#fff" opacity="${(0.04+rnd()*0.07).toFixed(2)}"/>`;}
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Rolly">
<title>Rolly</title>
<style>
  .spin{animation:spin 1.6s linear infinite;transform-box:view-box;transform-origin:256px 236px}
  .bob{animation:bob .8s ease-in-out infinite}
  .shadow{animation:shadow .8s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
  .road{animation:road .8s linear infinite}
  .eye{animation:blink 4.2s infinite;transform-box:fill-box;transform-origin:center}
  .speed line{animation:speed .8s ease-in-out infinite}
  .speed line:nth-child(2){animation-delay:.2s}
  .speed line:nth-child(3){animation-delay:.4s}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
  @keyframes shadow{0%,100%{transform:scaleX(1);opacity:.55}50%{transform:scaleX(.9);opacity:.38}}
  @keyframes road{to{transform:translateX(-80px)}}
  @keyframes blink{0%,46%,50%,100%{transform:scaleY(1)}48%{transform:scaleY(.1)}}
  @keyframes speed{0%,100%{opacity:.15;transform:translateX(0)}50%{opacity:.9;transform:translateX(-10px)}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<defs>
  <clipPath id="bgc"><circle cx="256" cy="256" r="256"/></clipPath>
  <radialGradient id="bgg" cx=".5" cy=".38" r=".7"><stop offset="0" stop-color="#34343A"/><stop offset="1" stop-color="${C.asph2}"/></radialGradient>
  <radialGradient id="hubg" cx=".42" cy=".36" r=".75"><stop offset="0" stop-color="${C.yl}"/><stop offset=".6" stop-color="${C.y}"/><stop offset="1" stop-color="${C.yd}"/></radialGradient>
  <linearGradient id="rimg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.y}"/><stop offset="1" stop-color="${C.yd}"/></linearGradient>
</defs>
<g clip-path="url(#bgc)">
  <rect width="512" height="512" fill="url(#bgg)"/>
  ${sp}
  <!-- road -->
  <rect x="0" y="420" width="512" height="92" fill="${C.asph2}" opacity=".55"/>
  <g class="road">${Array.from({length:9},(_,i)=>`<rect x="${i*80-10}" y="452" width="46" height="10" rx="5" fill="${C.y}"/>`).join('')}</g>
  <ellipse class="shadow" cx="256" cy="412" rx="122" ry="14" fill="#000"/>
</g>
<g class="speed" stroke="${C.y}" stroke-width="7" stroke-linecap="round" opacity=".9">
  <line x1="58" y1="190" x2="88" y2="190"/>
  <line x1="40" y1="236" x2="82" y2="236"/>
  <line x1="58" y1="282" x2="88" y2="282"/>
</g>
<g class="bob">
  <g class="spin">
    <g transform="translate(256 236)">
      ${tread.replace(/fill="#151517"/g,'fill="#151517" stroke="#4A4A52" stroke-width="2.5"')}
      <circle r="152" fill="${C.tire}" stroke="#4A4A52" stroke-width="2.5"/>
      <circle r="146" fill="none" stroke="#3A3A40" stroke-width="3" stroke-dasharray="14 10"/>
      <circle r="128" fill="${C.side}"/>
      <circle r="128" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="6"/>
      <circle r="108" fill="url(#rimg)"/>
      <circle r="108" fill="none" stroke="${C.yd}" stroke-width="5"/>
      ${holes}
      ${nuts}
    </g>
  </g>
  <!-- face hub: stays upright -->
  <g transform="translate(256 236)">
    <circle r="70" fill="url(#hubg)" stroke="${C.yd}" stroke-width="5"/>
    <ellipse cx="-16" cy="-26" rx="22" ry="11" fill="#fff" opacity=".35" transform="rotate(-25 -16 -26)"/>
    <g class="eye"><ellipse cx="-22" cy="-6" rx="11" ry="15" fill="${C.ink}"/><circle cx="-18" cy="-12" r="4.4" fill="#fff"/><circle cx="-25" cy="-1" r="1.6" fill="#fff"/></g>
    <g class="eye"><ellipse cx="22" cy="-6" rx="11" ry="15" fill="${C.ink}"/><circle cx="26" cy="-12" r="4.4" fill="#fff"/><circle cx="19" cy="-1" r="1.6" fill="#fff"/></g>
    <ellipse cx="-39" cy="14" rx="9" ry="5.5" fill="${C.blush}" opacity=".55"/>
    <ellipse cx="39" cy="14" rx="9" ry="5.5" fill="${C.blush}" opacity=".55"/>
    <path d="M -15 14 Q 0 32 15 14 Q 0 22 -15 14 Z" fill="${C.ink}" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M -6 22 Q 0 27 6 22 Q 0 20 -6 22 Z" fill="#FF6F61"/>
  </g>
</g>
</svg>`;
fs.writeFileSync(process.argv[2],svg);
