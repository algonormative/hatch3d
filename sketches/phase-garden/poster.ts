import type { Part, Point } from '../../src/sketch/types.ts';

// Original open-stroke alphabet. Coordinates use a 4 × 6 grid, with no font dependency.
const GLYPHS: Record<string, string> = {
 A:'0,6 0,2 2,0 4,2 4,6|0,4 4,4', B:'0,6 0,0 3,0 4,1 4,2 3,3 0,3|3,3 4,4 4,5 3,6 0,6',
 C:'4,0 1,0 0,1 0,5 1,6 4,6', D:'0,6 0,0 2,0 4,2 4,4 2,6 0,6', E:'4,0 0,0 0,6 4,6|0,3 3,3',
 F:'0,6 0,0 4,0|0,3 3,3', G:'4,0 1,0 0,1 0,5 1,6 4,6 4,3 2,3', H:'0,0 0,6|4,0 4,6|0,3 4,3',
 I:'0,0 4,0|2,0 2,6|0,6 4,6', J:'4,0 4,5 3,6 1,6 0,5', K:'0,0 0,6|4,0 0,3 4,6', L:'0,0 0,6 4,6',
 M:'0,6 0,0 2,3 4,0 4,6', N:'0,6 0,0 4,6 4,0', O:'1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
 P:'0,6 0,0 3,0 4,1 4,2 3,3 0,3', Q:'1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2,4 4,6',
 R:'0,6 0,0 3,0 4,1 4,2 3,3 0,3|2,3 4,6', S:'4,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 0,6',
 T:'0,0 4,0|2,0 2,6', U:'0,0 0,5 1,6 3,6 4,5 4,0', V:'0,0 2,6 4,0', W:'0,0 0,6 2,3 4,6 4,0',
 X:'0,0 4,6|4,0 0,6', Y:'0,0 2,3 4,0|2,3 2,6', Z:'0,0 4,0 0,6 4,6',
 '0':'1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|1,5 3,1', '1':'1,1 2,0 2,6|0,6 4,6',
 '2':'0,1 1,0 3,0 4,1 4,2 0,6 4,6', '3':'0,0 3,0 4,1 4,2 2,3 4,4 4,5 3,6 0,6',
 '4':'3,6 3,0 0,4 4,4', '5':'4,0 0,0 0,3 3,3 4,4 4,5 3,6 0,6',
 '6':'4,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3', '7':'0,0 4,0 1,6',
 '8':'1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0|1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3',
 '9':'4,3 1,3 0,2 0,1 1,0 3,0 4,1 4,5 3,6 0,6', '-':'0,3 4,3', '/':'0,6 4,0', '.':'2,5.5 2,6',
};

export function plotText(text: string, x: number, y: number, height: number, tracking = 1.8): Point[][] {
 const scale=height/6, paths:Point[][]=[];
 for(const char of text.toUpperCase()) {
  if(char===' '){x+=(3+tracking)*scale;continue;}
  const glyph=GLYPHS[char]; if(!glyph) throw new Error(`Unsupported poster character: ${char}`);
  for(const stroke of glyph.split('|')) paths.push(stroke.split(' ').map(pair=>{
   const [u,v]=pair.split(',').map(Number);return {x:x+u*scale,y:y+v*scale};
  }));
  x+=(4+tracking)*scale;
 }
 return paths;
}

export function posterFrame({subtitle,edition,pen='carbon'}:{subtitle:string;edition:string;pen?:string}):Part[]{
 const title=plotText('PHASE GARDEN',19,25,23,1.8);
 // Mitered stroke outlines keep the large lettering open and plottable.
 const outlined=title.map(path=>{
  const sides=[-1,1].map(sign=>path.map((p,i)=>{
   const a=path[Math.max(0,i-1)], b=path[Math.min(path.length-1,i+1)];
   const before=i?{x:p.x-a.x,y:p.y-a.y}:{x:b.x-p.x,y:b.y-p.y};
   const after=i<path.length-1?{x:b.x-p.x,y:b.y-p.y}:before;
   const l0=Math.hypot(before.x,before.y),l1=Math.hypot(after.x,after.y);
   const n0={x:-before.y/l0,y:before.x/l0},n1={x:-after.y/l1,y:after.x/l1};
   const denom=1+n0.x*n1.x+n0.y*n1.y;
   const scale=sign*.34/Math.max(.35,denom);
   return {x:p.x+(n0.x+n1.x)*scale,y:p.y+(n0.y+n1.y)*scale};
  }));
  const ring=[...sides[0],...sides[1].reverse()];return [...ring,ring[0]];
 });
 return [
  {id:'poster-title',pen,paths:outlined},
  {id:'poster-caption',pen,paths:[...plotText('LIVE ELECTRONIC SYSTEMS',19,60,3.2),...plotText(subtitle,19,378,5),...plotText('CONCERT STUDY / '+edition,19,394,3.2)]},
  {id:'poster-rules',pen,paths:[[{x:19,y:69},{x:278,y:69}],[{x:19,y:368},{x:278,y:368}],[{x:265,y:394},{x:278,y:394}]]},
 ];
}
