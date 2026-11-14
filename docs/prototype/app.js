const DOI={C:'10.xxxx/xxxxx'}; // placeholder DOI to show the link format (示例)
// Graphictero – clickable prototype v4.6. Routes #/01 … #/08 (or ?screen=0N). Layout: dagre (vendored). All paper-specific content is example text.
const P={
 A:{t:'When Is Enough Not Enough? Illusory Completion in Search Agents',s:'Illusory Completion',a:'Ko et al.',fa:'ko',one:'示例：指出搜索智能体常在证据不足时就自认为已完成任务（illusory completion），并分析其成因。'},
 B:{t:'When Absence Is Evidence: Evaluating …',s:'When Absence Is Evidence',a:'—',fa:'anon',one:'示例：讨论「检索不到」本身何时可以作为证据，并据此评测智能体的判断。'},
 C:{t:'HALT: Verification-Aware Stopping for Retrieval-Augmented Search Agents',s:'HALT',a:'Roh & Han',fa:'roh',one:'示例：用验证信号决定检索增强搜索智能体何时停止搜索、何时作答。'},
 D:{t:'CAS: Conformalized Agentic Search via Adaptive Retrieval and Policy Weighting',s:'CAS',a:'Zhu et al.',fa:'zhu',one:'示例：用 conformal 方法为智能体搜索的检索与停止决策提供可校准的保证。'},
 E:{t:'SGR-Bench: Benchmarking Search Agents on State-Gated Retrieval',s:'SGR-Bench',a:'Li et al.',fa:'li',one:'示例：构建依赖状态门控检索的评测集，考察智能体能否按需检索。'},
 F:{t:'BrowseComp-Plus: A More Fair and Transparent Evaluation Benchmark of Deep-Research Agent',s:'BrowseComp-Plus',a:'Chen et al.',fa:'chen',one:'示例：在固定语料上重建 BrowseComp 式任务，使深度研究智能体的评测更公平透明。'},
 G:{t:'Do LLM Agents Know How to Ground, Recover, and Assess? A Benchmark for Epistemic Competence',s:'Epistemic Competence',a:'Shao et al.',fa:'shao',one:'示例：评测智能体在溯源、纠错与自我评估上的认知能力。'},
 X:{t:'BrowseComp: A Simple Yet Challenging Benchmark for Browsing Agents',s:'BrowseComp',a:'Wei et al.',fa:'wei',one:'示例：难以直接检索到答案的浏览类问题集，用于评测浏览智能体。',cand:1,why:'BrowseComp-Plus 在它的任务基础上构建，图中缺少这篇源头基准（示例理由）。'},
 H:{t:'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection',s:'Self-RAG',a:'Asai et al.',fa:'asai',nopdf:1,one:'没有 PDF，暂无一句话摘要。拖入 PDF 并解析后自动生成。'},
 J:{t:'ReSearch: Learning to Reason with Search for LLMs via Reinforcement Learning',s:'ReSearch',a:'Chen et al.',fa:'chen',failed:1,one:'PDF 解析失败，暂无一句话摘要。'},
 R:{t:'ReAct: Synergizing Reasoning and Acting in Language Models',s:'ReAct',a:'Yao et al.',fa:'yao',dfail:1,one:'示例：让语言模型交替生成推理步骤和动作（如调用搜索）。'},
 L:{t:'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',s:'RAG（Lewis et al.）',a:'Lewis et al.',fa:'lewis',proc:1,one:'正在处理（解析 → 名片 → 详情），完成前没有一句话摘要。'},
 Z:{t:'R1-Searcher: Incentivizing the Search Capability in LLMs via Reinforcement Learning',s:'R1-Searcher',a:'Song et al.',fa:'song',cand:1,inlib:1,one:'示例：用两阶段强化学习激励模型主动调用检索。',why:'同样用 RL 学习何时检索，可与 Search-R1 并列对照（示例理由）。'},
 Y:{t:'Search-R1: Training LLMs to Reason and Leverage Search Engines with Reinforcement Learning',s:'Search-R1',a:'Jin et al.',fa:'jin',one:'示例：用强化学习训练模型在推理过程中调用搜索引擎。',cand:1,why:'用 RL 学习何时检索、何时停止，可与 CAS 的策略加权对照（示例理由）。'}};
const TAGS=['基于/改进','具体实现','对比','引用','同一作者'];
const NW=200,NH=64;
const GNAME='Agentic Search 评测与停止策略';
const S={pos:null,routes:{},dirty:new Set(),year:true,chat:true,side:true,chatW:360,theme:'light',open:{t2:true},
 cands:['X','Y'],
 edges:[
  {s:'A',t:'C',dir:1,tag:'基于/改进',tags:['基于/改进','对比'],full:'基于/改进：论文 C（HALT）以论文 A（When Is Enough Not Enough?）发现的…现象为出发点，指出 A 只描述了问题、没有给出…；C 为此提出了…，从而…。对比：两篇讨论的是同一类失败，A 从…角度分析原因，C 从…角度给出停止方法；C 的实验沿用了 A 的…设置，结果可以直接放在一起比较。'},
  {s:'C',t:'D',dir:1,tag:'对比',full:'论文 D（CAS）针对与论文 C（HALT）相同的问题：…；C 采用…，而 D 采用…，二者在…上的取舍不同。两篇可以放在一起读：前者更看重…，后者更看重…。'},
  {s:'B',t:'D',dir:1,tag:'具体实现',tags:['具体实现','引用'],full:'论文 D（CAS）将论文 B（When Absence Is Evidence）中提出的…思路具体实现为…，并在…上加以验证。B 只给出了判断依据，没有给出可执行的停止规则；D 把它落成了…，代价是需要额外的…。引用：D 的参考文献里直接列出了 B（由程序根据 OpenAlex 引用数据自动标注）。'},
  {s:'G',t:'D',dir:1,tag:'基于/改进',tags:['基于/改进','引用'],full:'基于/改进：论文 D（CAS）在实验中采用了论文 G（Epistemic Competence）的…评测设置，用于衡量…。引用：D 的参考文献里直接列出了 G（自动标注）。'},
  {s:'E',t:'F',dir:1,tag:'对比',full:'论文 F（BrowseComp-Plus）与论文 E（SGR-Bench）都旨在评测…；F 针对 E 的…做了对比：E 侧重…，F 侧重…。'},
  {s:'F',t:'G',dir:1,tag:'对比',tags:['对比','引用'],full:'对比：论文 G（Epistemic Competence）把论文 F（BrowseComp-Plus）作为对照基准，以说明…。引用：G 的参考文献里直接列出了 F（自动标注）。'},
  {s:'B',t:'E',dir:1,tag:'基于/改进',full:'论文 E（SGR-Bench）延续了论文 B 关于…的思路，并针对…进一步…。',nw:1},
  {s:'A',t:'G',dir:1,tag:'基于/改进',full:'论文 G（Epistemic Competence）把论文 A 发现的…现象转化为…评测维度。',nw:1}]};
S.edges.forEach(e=>{e.tags=e.tags||(e.tag?[e.tag]:[])});
const CANDLINK={X:{t:'F',dir:1,tag:'基于/改进',full:'论文 F（BrowseComp-Plus）在论文 X（BrowseComp）的任务基础上构建，改为…，以使评测…。'},Y:{t:'D',dir:1,tag:'对比',full:'论文 D（CAS）与论文 Y（Search-R1）都学习何时检索：Y 用…，D 用…，D 针对 Y 的…做了对比。'}};
Object.values(CANDLINK).forEach(e=>{e.tags=e.tag?[e.tag]:[]});
const $=s=>document.querySelector(s), app=$('#app');
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const go=h=>{location.hash=h};
const ck=k=>P[k].fa+'YYYY'+P[k].s.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8);
const I={back:'<path d="M10 3.5L5.5 8l4.5 4.5"/>',plus:'<path d="M8 3.5v9M3.5 8h9"/>',search:'<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2l3.3 3.3"/>',
 more:'<circle cx="3.6" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.4" cy="8" r=".6"/>',
 sliders:'<path d="M2.5 5h7M12.5 5h1M2.5 11h1M6.5 11h7"/><circle cx="11" cy="5" r="1.5"/><circle cx="5" cy="11" r="1.5"/>',
 chat:'<path d="M3 3.5h10a.5.5 0 01.5.5v6.5a.5.5 0 01-.5.5H7.5L4.5 13.5V11H3a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"/>',
 close:'<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',folder:'<path d="M2.5 4.5v7a1 1 0 001 1h9a1 1 0 001-1V6.5a1 1 0 00-1-1H8L6.5 4h-3a1 1 0 00-1 .5z"/>',
 doc:'<path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z"/><path d="M9 2.5V5h2.5"/>',
 tree:'<rect x="5.5" y="2" width="5" height="3.2" rx=".8"/><rect x="2" y="10.8" width="5" height="3.2" rx=".8"/><rect x="9" y="10.8" width="5" height="3.2" rx=".8"/><path d="M8 5.2v2.8M4.5 10.8V8h7v2.8"/>',
 dash:'<path d="M2.5 13.5l1.5-1.5M6 10l1.5-1.5M9.5 6.5L11 5M12.5 3.5"/><circle cx="12.6" cy="3.4" r=".6"/>',
 grid:'<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
 clock:'<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',star:'<path d="M8 2.8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 11l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z"/>',
 ext:'<path d="M9.5 2.5h4v4M13.5 2.5L8 8M11.5 9.5v4h-9v-9h4"/>',edit:'<path d="M10.5 3l2.5 2.5-7 7H3.5V10z"/>',trash:'<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
 check:'<path d="M3.5 8.5l3 3 6-7"/>',chevD:'<path d="M4.5 6.2L8 9.7l3.5-3.5"/>',chevR:'<path d="M6.2 4.5L9.7 8l-3.5 3.5"/>',
 sidebar:'<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',export:'<path d="M8 10V2.5M5 5.5l3-3 3 3M3 9.5v3.5h10V9.5"/>',
 rewrite:'<path d="M13 8a5 5 0 01-8.8 3.2M3 8a5 5 0 018.8-3.2"/><path d="M12 2.5v2.5H9.5M4 13.5V11h2.5"/>',arrowD:'<path d="M8 3v10M4.5 9.5L8 13l3.5-3.5"/>',
 link:'<path d="M6.8 9.2l2.4-2.4M7.2 4.6l.9-.9a2.4 2.4 0 013.4 3.4l-.9.9M8.8 11.4l-.9.9a2.4 2.4 0 01-3.4-3.4l.9-.9"/>',
 import:'<path d="M8 2.5V10M5 7l3 3 3-3M3 9.5v3.5h10V9.5"/>',cal:'<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
 lib:'<path d="M3 2.5v11M6 2.5v11M9 3l3 10.5"/>',quote:'<path d="M3 10.5c0-3 1-5 3.5-6M9 10.5c0-3 1-5 3.5-6"/>',sum:'<path d="M3 4h10M3 7h10M3 10h6"/>'};
Object.assign(I,{stop:'<rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/>',at:'<circle cx="8" cy="8" r="2.4"/><path d="M10.4 8v1.1a1.7 1.7 0 003.4 0V8A5.8 5.8 0 108 13.8"/>',
 send:'<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',marker:'<path d="M9.8 2.8l3.4 3.4-6 6H3.8V8.8z"/><path d="M2.5 14h11"/>',note:'<path d="M3 2.5h10v7.5l-3.5 3.5H3z"/><path d="M13 10H9.5v3.5"/>',
 panelR:'<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',x:'<path d="M5 5l6 6M11 5l-6 6"/>',info:'<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3V11M8 5.2v.1"/>',
 locate:'<circle cx="8" cy="8" r="3"/><path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4"/>',hist:'<path d="M2.8 8a5.2 5.2 0 101.6-3.8"/><path d="M2.5 2.8v2.6h2.6"/><path d="M8 5.3V8l1.8 1.2"/>',
 graph:'<circle cx="4" cy="4.5" r="1.8"/><circle cx="12" cy="4.5" r="1.8"/><circle cx="8" cy="12" r="1.8"/><path d="M5.2 5.9l1.9 4.4M10.8 5.9l-1.9 4.4"/>',
 rel:'<circle cx="3.8" cy="8" r="1.8"/><circle cx="12.2" cy="8" r="1.8"/><path d="M5.6 8h4.8"/>',bib:'<path d="M3 3.5h4.5a1.5 1.5 0 011.5 1.5v8.5a1.3 1.3 0 00-1.3-1.3H3z"/><path d="M13 3.5H9.8"/><path d="M13 3.5v8.7H9.6"/>',
 gear:'<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/>',
 thumbs:'<rect x="2.5" y="2.5" width="4.5" height="5.5" rx=".8"/><rect x="9" y="2.5" width="4.5" height="5.5" rx=".8"/><path d="M2.5 11h4.5M9 11h4.5M2.5 13.5h4.5M9 13.5h4.5"/>'});
const ic=(n,s=16,w=1.4)=>`<svg class="ic" width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
const lights=`<div class="lights"><i></i><i></i><i></i></div>`;
function toast(m,ms){document.querySelectorAll('.toast').forEach(t=>t.remove());const t=document.createElement('div');t.className='toast';t.textContent=m;app.appendChild(t);setTimeout(()=>t.remove(),ms||2200)}
function closePops(){document.querySelectorAll('.menu,.pop').forEach(m=>m.remove())}
document.addEventListener('click',e=>{if(!e.target.closest('.menu,.pop,[data-pop]'))closePops()});
function popAt(btn,html,alignRight){closePops();const r=btn.getBoundingClientRect(),a=app.getBoundingClientRect();const m=document.createElement('div');m.className='menu';
 if(alignRight) m.style.right=(a.right-r.right)+'px'; else m.style.left=(r.left-a.left)+'px'; m.style.top=(r.bottom-a.top+6)+'px'; m.innerHTML=html; app.appendChild(m); return m;}

let Q=new URLSearchParams(), JOBS='ok';
function route(){
  {const t=new URLSearchParams(location.search).get('theme'); if(t&&!S._t){S.theme=t;S.themePref=t;S._t=1}}
  document.documentElement.dataset.theme=S.theme; app.dataset.theme=S.theme;
  const q=new URLSearchParams(location.search); let h=location.hash.slice(1);
  if(!h.startsWith('/')) h='';
  if(!h&&q.get('screen')){const r=new URLSearchParams(q);r.delete('screen');r.delete('theme');h='/'+q.get('screen')+(r.toString()?'?'+r:'');}
  if(!h) h='/01';
  const [path,qs]=h.split('?'); Q=new URLSearchParams(qs||''); const scr=path.slice(1);
  closePops(); clearTimeout(tipT);
  JOBS=Q.get('jobs')||({'02':'fail','04':'fail','06':'fail','08':'fail','09':'fail','10':'fail'}[scr]||'ok');
  if(scr==='00') firstRun(); else if(scr==='01') home(); else if(scr==='05') settings(Q.get('sec')||'gen');
  else if(scr==='03e') detail(Q.get('paper')||'H');
  else if(scr==='09') {graph({});setTimeout(()=>jobsPop($('.jobs')),0);}
  else if(scr==='10') buildPage();
  else if(scr==='03') detail(Q.get('paper')||'C',Q.get('state'));
  else if(scr==='03b') detail(Q.get('paper')||'L',Q.get('state')||'parsing');
  else if(scr==='03c') {detail('C');regenConfirm();}
  else if(scr==='03d') detail(Q.get('paper')||'J','failed');
  else if(scr==='07') reader();
  else if(scr==='06') graph({panel:'edge',edge:+(Q.get('edge')||0)});
  else if(scr==='04') graph({dialog:'add'});
  else if(scr==='08') graph({dialog:'export'});
  else if(Q.get('del')) graph({dialog:'del',k:Q.get('del')});
  else if(Q.get('regenrel')) graph({dialog:'regenrel'});
  else if(Q.get('quit')) graph({dialog:'quit'});
  else graph({flash:Q.get('flash')==='1',tip:Q.get('tip')});
  if(Q.get('nmenu')) setTimeout(()=>nodeMenu(Q.get('nmenu')),0);
  if(Q.get('sess')==='1') setTimeout(()=>sessMenu($('.sessbtn')),0);
  if(Q.get('built')==='1') setTimeout(()=>toast(`建图完成 · ${inGraph().filter(k=>!P[k].cand&&!lone(k)).length} 篇论文参与，生成 ${S.edges.length} 条关系`,8000),0);
  if(Q.get('menu')==='1') setTimeout(()=>moreMenu({stopPropagation(){},currentTarget:$('button[title="更多"]')}),0);
}
window.addEventListener('hashchange',route);

/* ---------- shared sidebar (home/settings) ---------- */
function navSide(on){
  const it=(k,icn,l,h,n)=>`<div class="sitem ${on===k?'on':''}" onclick="go('${h}')">${ic(icn)}${l}${n?`<span class="n">${n}</span>`:''}</div>`;
  return `<div class="sidebar">${lights}<div class="sbody" style="padding-top:8px;gap:1px">
   ${it('all','grid','全部图谱','/01',4)}${it('rec','clock','最近打开','/01')}${it('lib','lib','论文库','/01',42)}
   <div class="shead"><span class="cap">图谱</span></div>
   ${it('g1','tree',GNAME,'/02')}${it('g2','tree','搜索智能体：认知能力与可信度','/02')}${it('g3','tree','PhD 套磁：检索增强智能体','/02')}
   <div class="grow"></div>${it('set','sliders','设置','/05')}</div>
   <div class="zfoot">${ic('lib',14)}论文库 · 42 篇（示例）· 上次导入 —</div></div>`;
}
/* ---------- 01 home ---------- */
function thumb(seed){
  const L=[[[110,22],[60,62],[160,62],[110,102],[210,102]],[[80,30],[180,30],[130,75],[130,118]],[[70,24],[170,24],[70,70],[170,70],[120,116],[220,116]],[[90,40],[190,40],[140,100]]][seed];
  const E=[[[0,1],[0,2],[2,3],[2,4]],[[0,2],[1,2],[2,3]],[[0,2],[1,3],[2,4],[3,4],[3,5]],[[0,2],[1,2]]][seed];
  const w=56,h=20;
  return `<svg width="100%" height="150" viewBox="10 0 280 140" preserveAspectRatio="xMidYMid meet">${E.map(([a,b])=>{const A=L[a],B=L[b];const y1=A[1]+h/2,y2=B[1]-h/2;const my=(y1+y2)/2;return `<path d="M${A[0]} ${y1}C${A[0]} ${my} ${B[0]} ${my} ${B[0]} ${y2}" stroke="var(--edge)" stroke-width="1" fill="none"/>`}).join('')}${L.map(p=>`<rect x="${p[0]-w/2}" y="${p[1]-h/2}" width="${w}" height="${h}" rx="4" fill="var(--node)" stroke="var(--nodeb)"/><rect x="${p[0]-w/2+7}" y="${p[1]-3}" width="${w-22}" height="3" rx="1.5" fill="var(--edge2)"/><rect x="${p[0]-w/2+7}" y="${p[1]+3}" width="${w-34}" height="2.5" rx="1.25" fill="var(--line2)"/>`).join('')}</svg>`;
}
function home(){
  const cards=[[GNAME,'综述','11 篇论文 · 8 条关系'],['搜索智能体：认知能力与可信度','综述','5 篇论文 · 4 条关系'],['PhD 套磁：检索增强智能体方向梳理','套磁准备','9 篇论文 · 7 条关系'],['Deep Research 基准对比（草稿）','草稿','3 篇论文 · 1 条关系']];
  app.innerHTML=navSide('all')+`<div class="homemain">
   <div class="row" style="height:52px;gap:8px;justify-content:flex-end"><span style="margin-right:auto;font-size:13px;font-weight:600;color:var(--text)">Graphictero</span>${jobsBtn()}<div class="field" style="width:220px">${ic('search',14)}搜索图谱或论文</div><button class="btn bordered" onclick="go('/04')">${ic('import',15)}从 Zotero 导入</button><button class="btn primary" onclick="go('/02')">${ic('plus',15,1.6)}新建图谱</button></div>
   <div style="margin:28px 0 6px" class="h1">我的图谱</div>
   <div class="t3" style="font-size:13px;margin-bottom:28px">图谱独立于 Zotero 分类。论文从 Zotero 单向导入到本机论文库，不会写回 Zotero。</div>
   <div class="grid">${cards.map((c,i)=>`<div class="gcard" onclick="go('/02')"><div class="pv">${thumb(i)}</div><div class="nm">${c[0]}</div><div class="mt">${c[2]} · ${c[1]} · 更新于 —</div></div>`).join('')}
    <div><div class="newc" onclick="go('/02')">${ic('plus',18)}新建空白图谱</div><div class="mt t3" style="font-size:12px;margin-top:10px">从论文库挑选论文，或从 Zotero 导入整个分类</div></div></div></div>`;
}
/* ---------- 05 settings (v4.3: left group nav, one group per page) ---------- */
const SECS=[['gen','通用','sliders'],['import','导入来源','import'],['pdf','PDF 来源','doc'],['parse','PDF 解析','thumbs'],['usage','用量与费用','sum'],['data','数据与备份','lib']];
const PSRC=[{n:'开放获取',d:'arXiv / OpenAlex / Unpaywall 查到的合法开放版本',on:1},{n:'自定义 URL 模板',d:'<span class="mono">https://library.example.edu/resolve?doi={doi}</span>（示例，由你添加）',on:0,custom:1}];
function settings(sec){
  const sel=(v,w)=>`<span class="select" ${w?`style="min-width:${w}px"`:''}>${v}${ic('chevD',14)}</span>`;
  const th=k=>`<span class="${(S.themePref||S.theme)===k?'on':''}" onclick="S.themePref='${k}';S.theme='${k}'==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):'${k}';route()">${{light:'浅色',dark:'深色',system:'跟随系统'}[k]}</span>`;
  const r=(k,v)=>`<div class="grow-r" style="min-height:42px;padding:6px 16px"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const sw=(on,a)=>`<span class="sw ${on?'on':''}" onclick="${a||''}"><i></i></span>`;
  const gh=(t,first)=>`<div class="ghead" ${first?'':'style="margin-top:22px"'}>${t}</div>`;
  const nav=`<div class="sidebar">${lights}<div class="sbody" style="padding-top:4px;gap:1px">
    <div class="sitem" onclick="go('/01')" style="color:var(--text2)">${ic('back',15)}返回</div>
    <div class="shead"><span class="cap">设置</span></div>
    ${SECS.map(x=>`<div class="sitem ${sec===x[0]?'on':''}" onclick="go('/05?sec=${x[0]}')">${ic(x[2])}${x[1]}</div>`).join('')}
    <div class="grow"></div></div><div class="zfoot">${ic('info',14)}Graphictero · 版本 —（示例）</div></div>`;
  let body='';
  if(sec==='gen') body=`${gh('语言模型',1)}<div class="group">
    ${r('服务商',sel('DeepSeek'))}
    ${r('模型',`<span class="t3" style="font-size:11.5px">另有 deepseek-v4-pro</span>${sel('<span class="mono">deepseek-flash</span>')}`)}
    ${r('API Key',`<span class="select" style="min-width:240px"><span id="key" style="letter-spacing:1px">sk-••••••••••••</span><span class="linkbtn g" onclick="event.stopPropagation();const k=$('#key');const s=this.textContent==='显示';this.textContent=s?'隐藏':'显示';k.textContent=s?'sk-（示例，未填写）':'sk-••••••••••••'">显示</span></span><button class="btn bordered" onclick="this.previousElementSibling.after(Object.assign(document.createElement('span'),{className:'t3',textContent:'原型中不发起请求'}));this.remove()">测试连接</button>`)}</div>
   <div class="note">API Key 仅保存在本机。</div>
   ${gh('文献数据')}<div class="group">
    ${r('OpenAlex API Key',`<span class="select" style="min-width:240px;justify-content:flex-start;color:var(--text3)">未填写</span><button class="btn bordered" onclick="toast('原型中不发起请求')">测试连接</button>`)}</div>
   <div class="note">用于获取引用（referenced_works）和补全 DOI。保存在本机 .env，和 DeepSeek Key 一样不会进入备份。</div>
   ${gh('外观')}<div class="group">${r('主题',`<span class="seg">${th('light')}${th('dark')}${th('system')}</span>`)}</div>`;
  if(sec==='import') body=`${gh('Zotero',1)}<div class="group">
    ${r('来源',`Zotero · 单向导入${sel('Zotero',140)}`)}
    ${r('Zotero Local API',`<span class="row" style="gap:6px"><span class="zdot" style="background:var(--text2)"></span>可用 · <span class="mono">localhost:23119</span></span><button class="btn bordered" onclick="toast('已重新检测（原型）')">重新检测</button>`)}
    ${r('Zotero 数据目录',`<span style="color:var(--text)">~/Zotero</span><span class="t3">（示例路径）</span><button class="btn bordered">更改…</button>`)}
    ${r('Zotero 未运行时',`读取 zotero.sqlite 的只读副本`)}</div>
   <div class="note">需在 Zotero 设置中开启「允许本机其他应用与 Zotero 通信」。导入时复制 PDF 并记录 item key；导入后不依赖 Zotero，也不会写回。按 DOI 和 arXiv ID 判断是否已在库中，已在库中的不重复导入。</div>`;
  if(sec==='pdf') body=`${gh('查找 PDF 的来源',1)}<div class="group">
    ${PSRC.map((x,i)=>`<div class="grow-r srcrow ${x.on?'':'off'}"><span class="hdl" title="拖动排序">${ic('grip',14)}</span><span class="no">${i+1}</span><div class="grow"><div class="nm">${x.n}${x.on?'':'<span class="t3" style="font-size:11.5px;margin-left:8px">已停用</span>'}</div><div class="d">${x.d}</div></div>${x.custom?`<button class="btn icon" title="删除">${ic('trash',14)}</button>`:''}${sw(x.on,`PSRC[${i}].on=!PSRC[${i}].on;route()`)}</div>`).join('')}
    <div class="grow-r" style="min-height:40px"><span class="linkbtn" onclick="toast('添加自定义来源（原型）')">${'＋'} 添加自定义来源…</span><span class="grow"></span><span class="t3" style="font-size:11.5px">模板里用 <span class="mono">{doi}</span> 代表论文 DOI</span></div></div>
   <div class="note">没有 PDF 的论文会按上面的顺序逐个查找，找到即停止。拖动左侧手柄调整顺序。默认只有开放获取，不预置任何非官方来源。</div>
   <div class="later">机构代理 · 后续版本</div>
   ${gh('Unpaywall')}<div class="group">
    ${r('联系邮箱',`<span class="select" style="min-width:260px;justify-content:flex-start;color:var(--text3)">name@example.com（示例）</span>`)}</div>
   <div class="note">Unpaywall 要求每次查询附上一个邮箱，只用于查找开放获取版本。</div>`;
  if(sec==='parse') body=`${gh('MinerU（本机 PDF 解析）',1)}<div class="group">
    ${r('服务状态',`<span class="row" style="gap:6px"><span class="zdot" style="background:var(--text2)"></span>运行中 · 本机</span><button class="btn bordered" onclick="toast('已重新检测（原型）')">重新检测</button>`)}
    ${r('版本',`<span class="mono" style="color:var(--text)">x.y.z</span><span class="t3">（示例）· 锁定于 uv.lock，不自动升级</span>`)}
    ${r('模型文件',`已下载 · 约 — GB（示例）`)}
    ${r('最近一次解析',`今天 HH:MM · 成功（示例）`)}
    ${r('重新安装',`<span class="t3" style="font-size:11.5px">服务异常、无法启动时使用</span><button class="btn bordered" onclick="toast('重新安装 MinerU（原型）')">重新安装…</button>`)}</div>
   <div class="note">重新安装会重新下载 MinerU 和模型文件；已有的解析缓存和论文详情不受影响。</div>`;
  if(sec==='usage'){const u=[['对话',6.10],['详情生成',3.80],['关系生成',1.90],['名片',0.60]],tot=u.reduce((a,b)=>a+b[1],0),pk=[['高峰时段',8.20,'北京时间 9–12 点、14–18 点'],['空闲时段',4.20,'其余时间 · 单价为高峰的一半']];
   const bar=(v)=>`<span class="ubar"><i style="width:${Math.round(v/tot*100)}%"></i></span><span class="num">¥${v.toFixed(2)}</span>`;
   const calls=[['今天 HH:MM','关系生成','空闲','0.21'],['今天 HH:MM','对话','高峰','0.06'],['今天 HH:MM','详情生成','高峰','0.19'],['昨天 HH:MM','名片','空闲','0.01']];
   body=`${gh('本月用量 · YYYY 年 MM 月',1)}<div class="group">
    <div class="grow-r" style="min-height:64px"><div class="k">本月合计</div><div class="v" style="justify-content:flex-end"><span class="big">¥${tot.toFixed(2)}</span><span class="t3">（示例）</span></div></div>
    ${u.map(x=>`<div class="grow-r" style="min-height:40px"><div class="k">${x[0]}</div><div class="v">${bar(x[1])}</div></div>`).join('')}</div>
   ${gh('按时段')}<div class="group">
    ${pk.map(x=>`<div class="grow-r" style="min-height:46px"><div class="k">${x[0]}<div class="t3" style="font-size:11px;font-weight:400">${x[2]}</div></div><div class="v">${bar(x[1])}</div></div>`).join('')}</div>
   <div class="note">按请求发生的时间计价。现在是空闲时段（北京时间 HH:MM，示例）。</div>
   ${gh('最近调用')}<div class="group">
    ${calls.map(c=>`<div class="grow-r" style="min-height:36px"><div class="k" style="font-weight:400"><span class="t3" style="display:inline-block;width:92px">${c[0]}</span>${c[1]}</div><div class="v"><span class="ptag ${c[2]==='高峰'?'pk':''}">${c[2]}</span><span class="num">¥${c[3]}</span></div></div>`).join('')}</div>
   <div class="note">金额按 DeepSeek 返回的 token 用量估算，均为示例。不设上限，也不会提醒。</div>
   ${gh('DeepSeek 账户')}<div class="group">
    ${r('账户余额',`<span style="color:var(--text)">¥88.00</span><span class="t3">（示例）· 更新于 HH:MM</span><button class="btn bordered" onclick="toast('已刷新（原型）')">刷新</button>`)}</div>
   <div class="note">余额来自 DeepSeek 账户接口；充值请到 DeepSeek 官网。</div>`;}
  if(sec==='data') body=`${gh('存储',1)}<div class="group">
    ${r('存储位置',`<span class="mono pathm" title="~/Library/Application Support/Graphictero/"><span class="pth-a">~/Library/Application Support/</span><span class="pth-b">Graphictero/</span></span><button class="btn" style="flex:none" onclick="toast('选择数据目录的根位置（原型）')">更改…</button>`)}</div>
   <div class="note">不能放在 iCloud / Dropbox 同步目录里。改位置前会先做快照，再迁移数据。</div>
   ${gh('数据库备份')}<div class="group">
    ${r('自动备份',`每天一次 · 保留最近 7 份（示例）${sw(1)}`)}
    ${r('最近自动备份',`今天 HH:MM（示例）`)}
    ${r('完整备份',`<button class="btn bordered" onclick="toast('导出完整备份（原型）')">${ic('export',14)}导出完整备份…</button><button class="btn bordered" onclick="toast('从备份恢复（原型）')">从备份恢复…</button>`)}</div>
   <div class="note">完整备份包含论文库、PDF、解析缓存、图谱、笔记和对话。备份不包含 API Key（.env）。从备份恢复会替换当前数据，恢复前会再确认一次。</div>`;
  app.innerHTML=nav+`<div class="setmain"><div style="max-width:720px;margin:0 auto;padding:0 40px 40px">
   <div style="height:40px"></div><div class="h1" style="margin:8px 4px 18px">${SECS.find(x=>x[0]===sec)[1]}</div>${body}</div></div>`;
}
/* ---------- graph screens (02 / 04 / 06 / 08) ---------- */
let V={};
const inGraph=()=>Object.keys(P).filter(k=>!P[k].cand||S.cands.includes(k));
const lone=k=>P[k].nopdf||P[k].failed||P[k].dfail||P[k].proc; // D67: no-PDF / still processing / processing failed → no relations, shown in the 未参与 row
const NHk=k=>P[k].cand?94:NH;
function tbLights(show){return show?'':`<div class="lights" style="padding:0 10px 0 6px;height:auto">${'<i></i>'.repeat(3)}</div>`}
function graph(v){
  V=v; if(!S.pos) layout(); const side=S.side&&v.panel!=="edge";
  const nP=inGraph().filter(k=>!P[k].cand).length;
  app.innerHTML=(side?`<div class="sidebar">${lights}${libSide()}</div>`:'')+`
  <div class="maincol">
   <div class="toolbar">${tbLights(side)}
    <button class="btn icon" title="边栏" onclick="S.side=!S.side;S.view=null;graph(V)">${ic('sidebar',15)}</button>
    <button class="btn" onclick="go('/01')" style="color:var(--text2);padding-left:6px">${ic('back',15)}我的图谱</button>
    <span class="t3" style="margin:0 2px">/</span><span class="ttl" style="margin-left:4px">${GNAME}</span>
    <span class="t3" style="font-size:12px;margin-left:8px">${nP} 篇 · ${S.edges.length} 条关系</span>
    <div class="grow"></div>${jobsBtn()}
    <button class="btn" onclick="autoArrange()" style="color:var(--text2)">${ic('tree',15)}整理</button>
    <div class="sep"></div>
    <button class="btn primary" onclick="go('/04')">${ic('plus',15,1.6)}添加论文</button>
    <button class="btn icon" data-pop onclick="moreMenu(event)" title="更多">${ic('more',16,2.2)}</button>
    <button class="btn icon ${S.chat?'on':''}" onclick="S.chat=!S.chat;S.view=null;route()" title="对话">${ic('chat')}</button>
   </div>
   <div class="ws"><div class="canvas" id="cv"></div>${v.panel==='edge'?edgePanel(v.edge):''}${S.chat?chatDrawer(v.panel==='edge'?'edge':'graph'):''}</div>
  </div>${v.dialog==='add'?dialog():v.dialog==='export'?exportDlg():v.dialog==='del'?delDlg(v.k):v.dialog==='regenrel'?regenRelDlg():v.dialog==='quit'?quitDlg():''}`;
  drawCanvas(); afterDrawer();
}
function libSide(){
  const row=(k,on)=>`<div class="prow" draggable="true" onclick="go('/03?paper=${k}')"><div class="t">${P[k].t}</div><div class="m"><span>${P[k].a} · YYYY</span>${P[k].nopdf?'<span class="t3">无 PDF</span>':P[k].failed?'<span class="row" style="gap:5px">解析失败<span class="edot0"></span></span>':P[k].dfail?'<span class="row" style="gap:5px">详情失败<span class="edot0"></span></span>':P[k].proc?'<span class="row" style="gap:5px">处理中<span class="pdot"></span></span>':on?`<span class="t3">${ic('check',12)}</span>`:''}</div></div>`;
  return `<div class="sbody" style="gap:1px">
   <div class="field" style="margin:4px 0 6px">${ic('search',14)}搜索论文库</div>
   <div class="shead" style="padding-top:8px"><span class="cap">本图谱 · ${inGraph().filter(k=>!P[k].cand).length}</span></div>
   ${['C','D','A','B','E','F','G','H','J','R','L'].map(k=>row(k,1)).join('')}
   <div class="shead" style="margin-top:4px"><span class="cap">论文库 · 其他</span><span class="linkbtn g" style="font-size:11.5px" onclick="go('/04')">从 Zotero 导入</span></div>
   <div class="prow"><div class="t">${P.Z.t}</div><div class="m"><span>Song et al. · YYYY</span></div></div>
   <div class="grow"></div><div class="t3" style="font-size:11.5px;padding:8px;line-height:17px">拖到画布加入图谱；拖到对话框作为上下文</div></div>`;
}
function moreMenu(e){
  e.stopPropagation(); popAt(e.currentTarget,`<div class="mi" onclick="go('/04')">${ic('import',15)}从 Zotero 导入整个分类…</div>
   <div class="mi" onclick="S.year=!S.year;graph(V)">${ic('cal',15)}显示年份<span class="kb">${S.year?ic('check',14):''}</span></div>
   <div class="mi" onclick="toast('按关系类型筛选（原型）')">${ic('sliders',15)}按关系类型筛选…</div>
   <div class="mi" onclick="go('/02?regenrel=1')">${ic('rewrite',15)}重新生成关系…</div><div class="ms"></div>
   <div class="mi" onclick="go('/08')">${ic('export',15)}导出 Markdown…</div>
<div class="ms"></div>
   <div class="mi" onclick="go('/05')">${ic('gear',15)}设置<span class="kb">⌘,</span></div>`,true);
}
function autoArrange(){ S.pos=null; S.view=null; S.dirty.clear(); graph(V); toast('已按关系重新整理'); }
function confirmCand(k){ S.cands=S.cands.filter(x=>x!==k); P[k].cand=0; const l=CANDLINK[k]; S.edges.push({s:k,...l}); S.pos=null;S.view=null; route(); toast(`已加入图谱：${P[k].s} · 已生成 1 条关系`); }
function ignoreCand(k){ S.cands=S.cands.filter(x=>x!==k); S.pos=null;S.view=null; route(); toast(`已忽略：${P[k].s}`); }

/* layout (dagre) & edge routing — positions are world coords; the world is scaled to fit */
function allEdges(){return S.edges.map((e,i)=>({...e,key:'e'+i,idx:i}))}
function layout(){
  const g=new dagre.graphlib.Graph({multigraph:true}); g.setGraph({rankdir:'TB',nodesep:56,ranksep:72,edgesep:24,marginx:0,marginy:0,ranker:'network-simplex'}); g.setDefaultEdgeLabel(()=>({}));
  inGraph().filter(k=>!lone(k)).forEach(k=>g.setNode(k,{width:NW,height:NHk(k)}));
  const LE=allEdges(); LE.filter(e=>e.idx!==2).concat(LE.filter(e=>e.idx===2)).forEach(e=>g.setEdge(e.s,e.t,{},e.key)); // B→D added last: dagre ordering avoids a crossing
  S.cands.forEach(k=>{const l=CANDLINK[k]; g.setEdge(k,l.t,{minlen:1},'ghost'+k)}); // placement only, never drawn
  dagre.layout(g);
  S.pos={}; g.nodes().forEach(k=>{const n=g.node(k); S.pos[k]=[Math.round(n.x-NW/2),Math.round(n.y-NHk(k)/2)]});
  {const ps=Object.entries(S.pos); const x0=Math.min(...ps.map(p=>p[1][0])), yb=Math.max(...ps.map(([k,p])=>p[1]+NHk(k)));
   inGraph().filter(lone).forEach((k,i)=>{S.pos[k]=[x0+i*(NW+40),yb+84]});}
  const raw={}; g.edges().forEach(o=>{if(o.name.startsWith('ghost'))return; raw[o.name]={v:o.v,w:o.w,pts:g.edge(o).points.map(p=>[p.x,p.y])}});
  const out={},inn={}; Object.entries(raw).forEach(([k,r])=>{(out[r.v]=out[r.v]||[]).push(k);(inn[r.w]=inn[r.w]||[]).push(k)});
  const port={};
  const spread=(lst,which)=>{lst.sort((a,b)=>{const pa=raw[a].pts,pb=raw[b].pts;const xa=which==='s'?pa[1][0]:pa[pa.length-2][0],xb=which==='s'?pb[1][0]:pb[pb.length-2][0];return xa-xb});
    lst.forEach((k,i)=>{(port[k]=port[k]||{})[which]=(i-(lst.length-1)/2)*Math.min(44,NW/(lst.length+1))})};
  Object.values(out).forEach(l=>spread(l,'s')); Object.values(inn).forEach(l=>spread(l,'t'));
  S.routes={}; Object.entries(raw).forEach(([k,r])=>{const a=S.pos[r.v],b=S.pos[r.w];
    const st=[a[0]+NW/2+port[k].s,a[1]+NHk(r.v)], en=[b[0]+NW/2+port[k].t,b[1]];
    S.routes[k]=[st,...r.pts.slice(1,-1).filter(p=>p[1]>st[1]+20&&p[1]<en[1]-20),en]});
}
function fit(cw,ch){
  const ks=inGraph(); let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; ks.forEach(k=>{const p=S.pos[k];x0=Math.min(x0,p[0]);y0=Math.min(y0,p[1]);x1=Math.max(x1,p[0]+NW);y1=Math.max(y1,p[1]+NHk(k))});
  const w=x1-x0,h=y1-y0, z=Math.min(1,(cw-72)/w,(ch-96)/h);
  S.view={z,tx:Math.round((cw-w*z)/2-x0*z),ty:Math.round(Math.max(40,(ch-h*z)/2-12)-y0*z),cw};
}
function curve(pts){
  if(pts.length>=2){let d=`M${pts[0][0]},${pts[0][1]}`;for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1],my=(a[1]+b[1])/2;d+=` C${a[0]},${my} ${b[0]},${my} ${b[0]},${b[1]}`}return d;}
}
function freeRoute(s,t){
  const a=S.pos[s],b=S.pos[t],ha=NHk(s),hb=NHk(t); const ac=[a[0]+NW/2,a[1]+ha/2], bc=[b[0]+NW/2,b[1]+hb/2]; const dx=bc[0]-ac[0], dy=bc[1]-ac[1];
  if(Math.abs(dy)>(ha+hb)/2+8){const p1=[ac[0],dy>0?a[1]+ha:a[1]], p2=[bc[0],dy>0?b[1]:b[1]+hb]; const my=(p1[1]+p2[1])/2; return `M${p1[0]},${p1[1]} C${p1[0]},${my} ${p2[0]},${my} ${p2[0]},${p2[1]}`}
  const p1=[dx>0?a[0]+NW:a[0],ac[1]], p2=[dx>0?b[0]:b[0]+NW,bc[1]]; const mx=(p1[0]+p2[0])/2; return `M${p1[0]},${p1[1]} C${mx},${p1[1]} ${mx},${p2[1]} ${p2[0]},${p2[1]}`;
}
function edgePath(e){ if(S.routes[e.key]&&!S.dirty.has(e.s)&&!S.dirty.has(e.t)) return curve(S.routes[e.key]); return freeRoute(e.s,e.t); }
function drawCanvas(){
  const cv=$('#cv'); if(!cv) return;
  if(!S.pos) layout();
  if(!S.view||S.view.cw!==cv.clientWidth) fit(cv.clientWidth,cv.clientHeight);
  const vw=S.view, sel=V.panel==='edge'&&S.edges[V.edge], en=new Set(sel?[sel.s,sel.t]:[]), fl=new Set();
  if(V.flash) S.edges.forEach(e=>{if(e.nw){fl.add(e.s);fl.add(e.t)}});
  const nodes=inGraph().map(k=>{const p=S.pos[k],c=P[k].cand,np=P[k].nopdf,fd=P[k].failed||P[k].dfail,pr=P[k].proc,ft=P[k].failed?'解析失败':'详情失败';
    return `<div class="node ${c?'cand':''} ${np?'nopdf':''} ${fd?'failed':''} ${pr?'proc':''} ${en.has(k)?'end':''}" data-k="${k}" style="left:${p[0]}px;top:${p[1]}px" onmouseenter="tip('${k}',1)" onmouseleave="tip('${k}',0)">
     ${fd?`<span class="edot" title="${ft}"></span>`:pr?'<span class="edot pr" title="处理中"></span>':''}<div class="t">${P[k].t}</div><div class="m">${c?'候选 · Agent 发现':P[k].a}${S.year?' · YYYY':''}${np?'<span class="npt">无 PDF</span>':''}${fd?`<span class="npt">${ft}</span>`:''}${pr?'<span class="npt">处理中</span>':''}</div>
     ${c?`<div class="acts"><button class="btn ok" onclick="event.stopPropagation();confirmCand('${k}')">${ic('check',12,1.6)}确认</button><button class="btn" onclick="event.stopPropagation();ignoreCand('${k}')">忽略</button></div>`:''}</div>`}).join('');
  const lk=inGraph().filter(lone), lcap=lk.length?`<div class="lonecap" style="left:${S.pos[lk[0]][0]}px;top:${S.pos[lk[0]][1]-24}px">未参与关系 · 无 PDF / 处理中 / 处理失败，处理完成后自动补关系</div>`:'';
  cv.innerHTML=`<div class="world" id="world" style="transform:translate(${vw.tx}px,${vw.ty}px) scale(${vw.z})"><svg class="edges" id="esvg"></svg><div id="labs"></div>${lcap}${nodes}<div class="ntip" id="ntip"></div></div>
   <div class="legend nleg"><span><i class="sw n"></i>论文</span><span><i class="sw c"></i>候选（Agent 发现）</span><span><i class="sw p"></i>无 PDF · 不参与关系</span><span><i class="sw n f pr"><b></b></i>处理中</span><span><i class="sw n f"><b></b></i>处理失败</span><span class="hint">悬停看摘要 · 右键更多操作</span></div>
   <div class="zoom"><span>−</span><span>${Math.round(vw.z*100)}%</span><span>+</span></div>`;
  cv.querySelectorAll('.node').forEach(n=>{n.addEventListener('pointerdown',drag);n.addEventListener('contextmenu',ev=>{ev.preventDefault();nodeMenu(n.dataset.k)})});
  drawEdges(); if(Q.get('hov')) hov(Q.get('hov'),1);
  if(V.tip) tip(V.tip,1,true);
}
let tipT;
function tip(k,on,now){
  clearTimeout(tipT); const t=$('#ntip'); if(!t) return;
  if(!on){t.classList.remove('show');return}
  const show=()=>{const p=S.pos&&S.pos[k]; if(!p||!document.contains(t)) return; t.innerHTML=`<div class="k">${P[k].nopdf?'无 PDF · 不参与关系生成':P[k].failed?'解析失败 · 点击查看':P[k].dfail?'详情生成失败 · 不参与关系 · 点击查看':P[k].proc?'处理中 · 完成后自动补关系':'一句话摘要'+(P[k].cand?' · 候选':'')}</div>${esc(P[k].one)}`; t.style.left=(p[0]-24)+'px'; t.style.top=(p[1]+NHk(k)+8)+'px'; t.classList.add('show')};
  now?show():tipT=setTimeout(show,350);
}
function drawEdges(){
  const svg=$('#esvg'), labs=$('#labs'); if(!svg) return;
  const selKey=V.panel==='edge'?'e'+V.edge:null;
  let h='', L='';
  allEdges().forEach(e=>{
    const d=edgePath(e), sel=e.key===selKey, fl=V.flash&&e.nw;
    const col=sel||fl?'var(--accent)':'var(--edge)';
    h+=`<path d="${d}" fill="none" stroke="${col}" stroke-width="${sel||fl?1.75:1.25}" data-k="${e.key}" class="ep"/>`;
    h+=`<path d="${d}" fill="none" stroke="transparent" stroke-width="14" style="cursor:pointer" onmouseenter="hov('${e.key}',1)" onmouseleave="hov('${e.key}',0)" onclick="go('/06?edge=${e.idx}')"/>`;
    L+=`<div class="elab show ${sel||fl?'sel':''}" id="lab-${e.key}">${fl?'<span class="tg">新增 ·</span>':''}${e.tags.length?esc(e.tags.join(' · ')):'<span class="tg">未定类型</span>'}</div><div class="etip" id="etip-${e.key}"><span>${esc(e.full)}</span></div>`;
  });
  svg.innerHTML=h; labs.innerHTML=L;
  let ah='';
  svg.querySelectorAll('path.ep').forEach(p=>{
    const e=allEdges().find(x=>x.key===p.dataset.k), len=p.getTotalLength(), m=p.getPointAtLength(len/2);
    const lab=$('#lab-'+e.key); lab.style.left=m.x+'px'; lab.style.top=m.y+'px'; const et=$('#etip-'+e.key); et.style.left=m.x+'px'; et.style.top=(m.y+12)+'px';
    if(e.dir){const tip=p.getPointAtLength(len), bk=p.getPointAtLength(Math.max(0,len-7)); const a=Math.atan2(tip.y-bk.y,tip.x-bk.x),W=3.6,Lh=7;
      const bx=tip.x-Lh*Math.cos(a), by=tip.y-Lh*Math.sin(a);
      ah+=`<polygon points="${tip.x},${tip.y} ${bx+W*Math.sin(a)},${by-W*Math.cos(a)} ${bx-W*Math.sin(a)},${by+W*Math.cos(a)}" fill="${p.getAttribute('stroke')}"/>`;}
  });
  svg.insertAdjacentHTML('beforeend',ah);
}
function hov(k,on){const l=$('#lab-'+k); if(!l) return; l.classList.toggle('hv',!!on); const et=$('#etip-'+k); if(et) et.classList.toggle('show',!!on); const p=document.querySelector(`path.ep[data-k="${k}"]`); if(p&&!on&&p.dataset.c){p.setAttribute('stroke',p.dataset.c)} else if(p&&on){p.dataset.c=p.getAttribute('stroke');p.setAttribute('stroke','var(--edgeHi)')}}
function drag(ev){
  if(ev.target.closest('button')||ev.button!==0) return;
  const n=ev.currentTarget,k=n.dataset.k,sx=ev.clientX,sy=ev.clientY,o=[...S.pos[k]],z=S.view.z;let moved=false;
  n.setPointerCapture(ev.pointerId); tip(k,0);
  const mv=e=>{const dx=(e.clientX-sx)/z,dy=(e.clientY-sy)/z; if(Math.abs(dx)+Math.abs(dy)>4) moved=true; if(moved){S.pos[k]=[o[0]+dx,o[1]+dy]; S.dirty.add(k); n.style.left=S.pos[k][0]+'px'; n.style.top=S.pos[k][1]+'px'; drawEdges();}};
  const up=e=>{n.removeEventListener('pointermove',mv);n.removeEventListener('pointerup',up); if(!moved&&e.button===0) go('/03?paper='+k);};
  n.addEventListener('pointermove',mv);n.addEventListener('pointerup',up);
}

/* ---------- chat drawer (D30) ---------- */
const SESS={nopdf:[['新会话','今天']],pother:[['新会话','今天']],graph:[['停止策略脉络梳理','今天'],['找缺失的基准论文','昨天'],['初次构建后的检查','10月22日']],paper:[['HALT 与 CAS 的停止判据','今天'],['HALT 方法细节','昨天']],edge:[['给这条关系补上对比','今天']],reader:[['阅读 HALT §4','今天'],['HALT 与 CAS 的停止判据','今天']]};
function trace(id,lines,openIdx){
  return `<div class="trace">${lines.map((l,i)=>`<div class="tl" onclick="const q=this.nextElementSibling;q.style.display=q.style.display==='none'?'block':'none';this.querySelector('.cv').innerHTML=q.style.display==='none'?'${ic('chevR',12).replace(/"/g,'&quot;')}':'${ic('chevD',12).replace(/"/g,'&quot;')}'"><span class="cv">${ic(i===openIdx?'chevD':'chevR',12)}</span>${l[0]}</div><div class="tq" style="display:${i===openIdx?'block':'none'}">${l[1]||'原文片段（展开后显示 MinerU 解析缓存中的对应段落，此处为占位）'}</div>`).join('')}</div>`;
}
function ccard(k){const done=!S.cands.includes(k)&&!P[k].cand;
  return `<div class="ccard ${done?'done':''}"><div class="t">${P[k].t}</div><div class="m">${P[k].a} · YYYY · arXiv —</div><div class="r">${P[k].why}</div>
   <div class="acts">${done?`<span class="t3" style="font-size:11.5px">${P[k].cand===0?'已确认，已加入图谱':'已忽略'}</span>`:S.cands.includes(k)?`<button class="btn sm" onclick="ignoreCand('${k}')">忽略</button><button class="btn sm bordered" style="color:var(--accent)" onclick="confirmCand('${k}')">确认加入</button>`:'<span class="t3" style="font-size:11.5px">已忽略</span>'}</div></div>`}
function figSvg(w){return `<svg width="${w}" viewBox="0 0 300 110" fill="none" stroke="var(--edge)" stroke-width="1.2" font-family="-apple-system,Noto Sans CJK SC,sans-serif" font-size="10">
  <rect x="6" y="40" width="58" height="28" rx="4" fill="var(--node)"/><text x="35" y="58" text-anchor="middle" fill="var(--text2)" stroke="none">Query</text>
  <rect x="90" y="40" width="70" height="28" rx="4" fill="var(--node)"/><text x="125" y="58" text-anchor="middle" fill="var(--text2)" stroke="none">Search step</text>
  <rect x="186" y="40" width="58" height="28" rx="4" fill="var(--node)"/><text x="215" y="58" text-anchor="middle" fill="var(--text2)" stroke="none">Verifier</text>
  <rect x="262" y="40" width="34" height="28" rx="4" fill="var(--node)"/><text x="279" y="58" text-anchor="middle" fill="var(--text2)" stroke="none">Stop</text>
  <path d="M64 54h24M160 54h24M244 54h16"/><path d="M215 40V18H125v20"/><text x="170" y="13" text-anchor="middle" fill="var(--text3)" stroke="none">continue</text>
  <text x="252" y="49" text-anchor="middle" fill="var(--text3)" stroke="none" font-size="8">≥τ</text></svg>`}
function chartSvg(){const v=[['固定步数',0.9],['自评置信',0.62],['CAS',0.48],['HALT',0.4]];
  return `<svg width="100%" height="104" viewBox="0 0 290 104" font-family="-apple-system,Noto Sans CJK SC,sans-serif" font-size="10">
   ${[0,1,2].map(i=>`<line x1="58" x2="286" y1="${8+i*36}" y2="${8+i*36}" stroke="var(--line)"/>`).join('')}
   ${v.map((r,i)=>`<text x="52" y="${20+i*22}" text-anchor="end" fill="var(--text2)">${r[0]}</text><rect x="58" y="${11+i*22}" width="${r[1]*220}" height="12" rx="2" fill="${r[0]==='HALT'?'var(--accent)':'var(--edge2)'}"/>`).join('')}
   <text x="58" y="102" fill="var(--text3)">0</text><text x="286" y="102" text-anchor="end" fill="var(--text3)">相对搜索步数（示例）</text></svg>`}
const DR={
 graph:()=>({ei:'graph',el:'对象',en:'整张图谱',cost:'0.42',chips:[['doc','BrowseComp-Plus']],input:'输入消息，@ 选论文…',running:true,body:`
  <div class="mu">把图里关于「何时停止搜索」的几篇串起来，看看还缺哪些关键论文。</div>
  ${trace('g1',[['读了 6 篇论文的名片','标题、摘要和一句话摘要（第一层上下文）'],['读了 HALT 详情','已生成的论文详情（第二层上下文）'],['读了 CAS §3 原文','“…(MinerU 解析出的原文段落，占位)…”'],['在 OpenAlex 搜索「browsing agent benchmark」']],1)}
  <div class="ma"><div>示例回答：HALT 与 CAS 都在回答「证据够了没有」，前者依赖验证信号，后者给出可校准的保证；SGR-Bench 延续了 When Absence Is Evidence 的思路。我补了 2 条关系，并找到 1 篇图外的源头基准。</div>
   <div class="gchg">${ic('link',14)}新增 2 条关系<span class="linkbtn" onclick="go('/02?flash=1')">定位</span><span class="kbd off" title="Agent 运行中，撤销暂不可用">⌘Z 撤销本轮全部改动</span></div>
   ${ccard('X')}</div>
  <div class="mu">再找找用强化学习训练搜索策略的工作。</div>
  ${trace('g2',[['在 OpenAlex 搜索「search agent reinforcement learning」'],['读了 Search-R1 摘要']])}
  ${ccard('Y')}${libCard('Z')}
  <div class="running"><span class="dot3"><i></i><i></i><i></i></span>正在读 CAS §2 相关工作…</div>`}),
 paper:()=>Q.get('chaterr')==='1'?chatErr():({ei:'doc',el:'对象',en:'论文 · HALT',cost:'0.18',chips:[],input:'问问这篇论文…',body:`
  <div class="mu"><div class="chipline"><span class="chip">${ic('doc',12)}<span>CAS</span></span></div>HALT 的停止判据和 CAS 有什么不同？配张图说明。</div>
  ${trace('p1',[['读了 CAS 名片'],['读了 HALT 详情'],['读了 HALT §3 原文'],['读了 HALT 图 2']])}
  <div class="ma"><div>示例回答：两者都在每一步判断证据是否足够。HALT 用验证器给出的分数与阈值 τ 比较；CAS 用 conformal 校准的集合大小来决定是否继续检索。</div>
   <div class="fblk" onclick="go('/07')"><div class="im">${figSvg(270)}</div><div class="cp"><span>HALT · 图 2　方法总览（原图占位）</span><span class="t3">p.4 ›</span></div></div>
   <div class="chart"><div class="tt">不同停止策略的相对搜索步数</div>${chartSvg()}<div class="src">数据来源：示例数值，仅示意（实际会注明取自哪篇论文哪张表，或标为 Agent 估计）</div></div>
   <div class="srcs"><span>来源：</span><span>HALT §3</span><span>HALT 图 2</span><span>CAS §4</span></div></div>`}),
 edge:()=>{const e=S.edges[V.edge]||S.edges[0]; if(+(V.edge||0)!==0) return {ei:'rel',el:'对象',en:`关系 · ${P[e.s].s} → ${P[e.t].s}`,cost:'0.00',chips:[],input:'问问这条关系…',body:`<div class="t3 sm" style="padding:18px 4px">还没有关于这条关系的对话。可以让 Agent 解释、改写或调整这条关系。</div>`};
  return {ei:'rel',el:'对象',en:'关系 · Illusory Completion → HALT',cost:'0.05',chips:[],input:'问问这条关系…',body:`
  <div class="mu">这条关系除了「基于/改进」，也算对比吧？补上，并重写说明。</div>
  ${trace('e1',[['读了两篇的名片'],['读了 HALT 详情'],['读了 Illusory Completion 详情']])}
  <div class="ma"><div>示例回答：两篇都在讨论搜索智能体「以为已经够了」的问题，一篇分析现象，一篇给出停止方法，也可以放在一起对比。已在「基于/改进」之外加上「对比」，方向不变（HALT 基于 / 针对 Illusory Completion），并改写了关系说明。</div>
   <div class="gchg">${ic('edit',14)}改了 1 条关系<span class="linkbtn" onclick="go('/06?edge=0')">定位</span><span class="kbd">⌘Z 撤销本轮全部改动</span></div></div>`}},
 pother:()=>{const k=window.DK||'C',ready=!window.DST;return {ei:'doc',el:'对象',en:'论文 · '+P[k].s,cost:'0.00',chips:[],input:'问问这篇论文…',body:`<div class="t3 sm" style="margin:auto;text-align:center;line-height:20px">还没有关于这篇论文的对话。${ready?'':'<br>详情生成前，只能基于标题、元数据和已完成的步骤回答。'}</div>`}},
 nopdf:()=>({ei:'doc',el:'对象',en:'论文 · '+P[Q.get('paper')||'H'].s,cost:'0.00',chips:[],input:'问问这篇论文…',body:`<div class="t3 sm" style="margin:auto;text-align:center;line-height:20px">这篇论文还没有 PDF。<br>现在只能基于标题和元数据回答。</div>`}),
 reader:()=>({ei:'doc',el:'对象',en:'论文 · HALT',cost:'0.09',chips:[['quote','选中文字 · p.4「…stops once the verifier score exceeds τ…」']],input:'这里的阈值 τ 是怎么选的？和 CAS 比呢？',typed:true,body:`
  <div class="mu">这一节的主要贡献是什么？</div>
  ${trace('r1',[['读了 HALT §4']])}
  <div class="ma"><div>示例回答：§4 给出验证感知的停止规则：每次检索后由验证器给当前证据打分，超过阈值 τ 即停止并作答，否则继续检索。</div>
   <div class="srcs"><span>来源：</span><span>HALT §4</span></div></div>`})};
function chatDrawer(kind){
  const D=DR[kind](), ss=kind==='edge'&&+(V.edge||0)!==0?[['新会话','今天']]:SESS[kind];
  return `<div class="drawer" style="width:${S.chatW}px"><div class="rz" onpointerdown="rz(event)" title="拖动调整宽度"></div>
   <div class="dh"><div class="sessbtn" data-pop onclick="sessMenu(this)" data-kind="${kind}"><span>${ss[0][0]}</span>${ic('chevD',13)}</div><div class="grow"></div>
    <button class="btn icon" title="新建会话" onclick="toast('新建会话（原型）')">${ic('plus',15)}</button>
    <button class="btn icon" title="收起" onclick="S.chat=false;S.view=null;route()">${ic('panelR',15)}</button></div>
   <div class="dsub">${ic(D.ei,13)}<b>${D.en}</b><span>· ${ss.length} 个会话</span></div>
   <div class="tx" id="tx">${D.body}</div>
   <div class="comp"><div class="cbox">${D.chips.length?`<div class="chips">${D.chips.map(c=>`<span class="chip">${ic(c[0],12)}<span>${c[1]}</span><span class="x">${ic('x',11)}</span></span>`).join('')}</div>`:''}
    <div class="cin ${D.typed?'typed':''}">${D.input}</div>
    <div class="cfoot"><button class="btn icon" title="@ 选论文">${ic('at',14)}</button><button class="btn icon" title="添加上下文">${ic('plus',14)}</button><span class="grow"></span><span class="t3" style="font-size:11px;margin-right:6px">deepseek-flash</span>
     ${D.running?`<button class="stopb" onclick="toast('已停止（原型）')"><i></i>停止</button>`:`<button class="sendb ${D.typed?'on':''}">${ic('send',14,1.6)}</button>`}</div></div>
    <div class="ccost">本会话累计 ¥${D.cost||'0.00'}（示例）</div></div></div>`;
}
function afterDrawer(){const t=$('#tx'); if(t) t.scrollTop=t.scrollHeight;}
function sessMenu(btn){ if(!btn) return; const kind=btn.dataset.kind||'graph', ss=SESS[kind];
  popAt(btn,`<div class="cap" style="padding:6px 10px 4px">${{graph:'整张图谱',paper:'论文 · HALT',edge:'这条关系',reader:'论文 · HALT',nopdf:'这篇论文',pother:'这篇论文'}[kind]} 的会话 · 按时间</div>`+
   ss.map((s,i)=>`<div class="mi"><span style="width:14px">${i===0?ic('check',13):''}</span>${s[0]}<span class="kb">${s[1]}</span></div>`).join('')+
   `<div class="ms"></div><div class="mi">${ic('plus',15)}新建会话<span class="kb">⌘N</span></div><div class="mi">${ic('edit',15)}重命名…</div><div class="mi" style="color:var(--danger)">${ic('trash',15)}删除会话…</div>`).style.minWidth='260px';
}
function rz(ev){ev.preventDefault();const sx=ev.clientX,w0=S.chatW;const mv=e=>{S.chatW=Math.max(300,Math.min(560,w0-(e.clientX-sx)));$('.drawer').style.width=S.chatW+'px'};
  const up=()=>{removeEventListener('pointermove',mv);removeEventListener('pointerup',up);S.view=null;if($('#cv'))drawCanvas()};addEventListener('pointermove',mv);addEventListener('pointerup',up);}
/* ---------- 06 relation panel ---------- */
function edgePanel(i){
  const e=S.edges[i]||S.edges[0];
  const card=k=>`<div class="pcard" onclick="go('/03?paper=${k}')"><div class="t">${P[k].t}</div><div class="m">${P[k].a} · YYYY</div></div>`;
  const dirTxt=`<b>${P[e.t].s}</b> 基于 / 针对 <b>${P[e.s].s}</b>`, AUTO=['引用','同一作者'];
  return `<div class="panel" style="width:320px"><div class="ph"><span class="t3" style="font-size:12px">关系</span><button class="btn icon" onclick="go('/02')">${ic('close',14)}</button></div>
  <div class="pth-b">
   <div class="sect" style="gap:6px">${card(e.s)}<div class="row t3" style="gap:6px;padding-left:12px;font-size:11.5px">${ic('arrowD',14)}<span style="color:var(--text)">${e.tags.length?esc(e.tags.join(' · ')):'未定类型'}</span></div>${card(e.t)}</div>
   <div class="sect"><div class="secth"><b>方向</b><span class="tagtxt">必填</span></div><div class="dirl">${dirTxt}</div><div class="t3" style="font-size:11.5px;line-height:17px">箭头从先出现的论文指向后来的论文：A → B 表示「B 基于 / 针对 A」。</div></div>
   <div class="sect"><div class="secth"><b>关系类型</b><span class="tagtxt">必填 · 可多选</span></div><div class="tags">${TAGS.map(t=>AUTO.includes(t)?`<span class="tag auto ${e.tags.includes(t)?'on':''}" title="由程序根据引用数据和作者信息自动填写，不能手动改">${t}<span class="au">自动</span></span>`:`<span class="tag ${e.tags.includes(t)?'on':''}" onclick="const g=S.edges[${i}].tags;g.includes('${t}')?g.splice(g.indexOf('${t}'),1):g.push('${t}');graph(V)">${t}</span>`).join('')}</div><div class="t3" style="font-size:11.5px;line-height:17px">「引用」「同一作者」由程序根据引用数据和作者信息自动填写，只读。</div></div>
   <div class="sect"><div class="secth"><b>关系说明</b><span class="tagtxt">Agent 撰写 · 示例</span></div><div class="quote ${V.ecol?'clamp':''}">${esc(e.full)}</div><button class="btn lnk" onclick="V.ecol=!V.ecol;graph(V)">${V.ecol?'展开':'收起'}</button></div>
   <div class="row" style="gap:4px;margin-left:-8px"><button class="btn" onclick="toast('编辑关系（原型）')">${ic('edit',14)}编辑</button><div class="grow"></div><button class="btn danger" onclick="S.edges.splice(${i},1);S.pos=null;S.view=null;go('/02');toast('已删除关系 · ⌘Z 撤销')">${ic('trash',14)}删除</button></div>
  </div></div>`;
}
/* ---------- 04 import from Zotero (one-way) ---------- */
const DLG={G:true,B:true,A:true};
function dialog(){
  const st={E:'已在图中',F:'已在图中',G:'已在论文库'}, keys=['E','F','G','B','A'], sel=['G','B','A'].filter(k=>DLG[k]), n=sel.length, all=n===3, nNew=sel.filter(k=>!st[k]).length;
  const cb=s=>`<span class="cb ${s}">${s==='on'?ic('check',11,2):''}</span>`;
  const ti=(lvl,l,c,on)=>`<div class="sitem ${on?'on':''}" style="padding-left:${8+lvl*14}px;white-space:nowrap">${ic('folder',15)}${l}<span class="n">${c}</span></div>`;
  return `<div class="ov" onclick="if(event.target===this)go('/02')"><div class="modal">
   <div style="padding:18px 20px 14px"><div class="row"><div class="grow" style="font-size:15px;font-weight:600">从 Zotero 导入论文</div><button class="btn icon" onclick="go('/02')">${ic('close',14)}</button></div>
    <div class="t3" style="font-size:12.5px;margin-top:2px">单向导入：复制 PDF 到本机论文库并记录 item key，不会修改 Zotero。导入后加入「${GNAME}」。</div></div>
   <div class="row grow" style="align-items:stretch;min-height:0;border-top:1px solid var(--line)">
    <div style="width:220px;background:var(--side);padding:10px 8px;display:flex;flex-direction:column;gap:1px"><div class="cap" style="padding:4px 8px 6px">Zotero 文库</div>${ti(0,'Agentic Search',12)}${ti(1,'Benchmarks',5,true)}${ti(1,'Stopping &amp; Verification',3)}${ti(0,'RAG',24)}${ti(0,'Thesis – MSc',18)}${ti(0,'未分类条目',9)}
     <div class="grow"></div><div class="t3" style="font-size:11px;padding:6px 8px;line-height:16px"><span class="zdot" style="background:var(--text2);display:inline-block;margin-right:5px"></span>Zotero Local API · 运行中</div></div>
    <div class="grow col" style="padding:12px 16px;gap:4px">
     <div class="field" style="margin-bottom:8px">${ic('search',14)}搜索标题、作者</div>
     <div class="row" style="justify-content:space-between;padding:4px 10px 6px"><span style="font-size:12px;font-weight:600;color:var(--text2)">Benchmarks · 5 篇</span><label class="row" style="gap:8px;font-size:12.5px;cursor:pointer" onclick="['G','B','A'].forEach(k=>DLG[k]=${!all});graph(V)">${cb(all?'on':'')}导入整个分类</label></div>
     ${keys.map(k=>{const d=st[k]==='已在图中',on=!d&&DLG[k];return `<div class="lrow ${d?'dis':''}" onclick="${d?'':`DLG.${k}=!DLG.${k};graph(V)`}">${cb(d?'dis':on?'on':'')}<div class="grow" style="min-width:0"><div class="t" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${P[k].t}</div><div class="t3" style="font-size:11.5px">${P[k].a} · YYYY · PDF</div></div>${st[k]?`<span class="t3" style="font-size:11.5px;white-space:nowrap">${st[k]}</span>`:''}</div>`}).join('')}
    </div></div>
   <div class="row" style="padding:12px 20px;border-top:1px solid var(--line);gap:8px"><span class="t3 grow" style="font-size:12.5px">已选 ${n} 篇 · ${nNew} 篇将新导入（复制 PDF），${n-nNew} 篇已在论文库</span><button class="btn bordered" onclick="go('/02')">取消</button><button class="btn primary" onclick="go('/02');setTimeout(()=>toast('已导入并添加 ${n} 篇 · MinerU 后台解析中'),50)">导入并添加 ${n} 篇</button></div>
  </div></div>`;
}
/* ---------- 08 export (D31) ---------- */
const XP={ov:true,det:false,tags:new Set(TAGS),refs:true};
function exportDlg(){
  const rad=(on,l,d,a)=>`<div class="ol" onclick="${a};graph(V)"><span class="rad ${on?'on':''}"></span><div><div>${l}</div>${d?`<div class="d">${d}</div>`:''}</div></div>`;
  const cbx=(on,l,d,a)=>`<div class="ol" onclick="${a};graph(V)"><span class="cb ${on?'on':''}">${on?ic('check',11,2):''}</span><div><div>${l}</div>${d?`<div class="d">${d}</div>`:''}</div></div>`;
  const ord=inGraph().filter(k=>!P[k].cand).sort((a,b)=>S.pos[a][1]-S.pos[b][1]||S.pos[a][0]-S.pos[b][0]);
  const rel=k=>S.edges.filter(e=>e.s===k&&e.tags.some(t=>XP.tags.has(t))).map(e=>`- ${e.tags.length?e.tags.join(' · '):'未定类型'} → ${P[e.t].s}`).join('\n');
  let md=`<b># ${GNAME}</b>\n导出于 YYYY-MM-DD · ${ord.length} 篇论文 · ${S.edges.filter(e=>e.tags.some(t=>XP.tags.has(t))).length} 条关系\n\n`;
  if(XP.ov) md+=`<b>## 概览</b>\n（Agent 撰写的研究线概览，示例）这条线围绕「搜索智能体何时停止」展开…\n\n`;
  ord.forEach(k=>{md+=`<b>## ${P[k].s}</b>\n${P[k].one}\n${rel(k)?rel(k)+'\n':''}${XP.det?'\n> 详情解读全文…\n':''}\n`});
  if(XP.refs) md+=`<b>## 参考文献</b>\n`+ord.map(k=>`- ${P[k].a}, YYYY, ${P[k].t}${DOI[k]?`. https://doi.org/${DOI[k]}（示例）`:''}`).join('\n');
  return `<div class="ov" onclick="if(event.target===this)go('/02')"><div class="modal" style="width:880px;height:600px">
   <div style="padding:18px 20px 14px"><div class="row"><div class="grow" style="font-size:15px;font-weight:600">导出 Markdown</div><button class="btn icon" onclick="go('/02')">${ic('close',14)}</button></div>
    <div class="t3" style="font-size:12.5px;margin-top:2px">按「整理」后的布局顺序输出，文末可附参考文献列表。</div></div>
   <div class="row grow" style="align-items:stretch;min-height:0;border-top:1px solid var(--line)">
    <div style="width:290px;padding:6px 20px 14px;border-right:1px solid var(--line);overflow:hidden" class="xopt">
     <div class="xh">内容</div>
     ${cbx(XP.ov,'研究线概览','由 Agent 撰写一段概览放在开头',"XP.ov=!XP.ov")}
     ${cbx(XP.det,'附上论文详情解读','每篇附完整解读，文件会明显变长',"XP.det=!XP.det")}
     <div class="xh">按关系类型</div>
     <div class="d" style="margin:-2px 0 4px;font-size:11.5px;color:var(--text3)">可多选；含任一选中类型的关系都会导出</div>
     <div class="xtags">${TAGS.map(t=>`<span class="xt ${XP.tags.has(t)?'on':''}" onclick="XP.tags.has('${t}')?XP.tags.delete('${t}'):XP.tags.add('${t}');graph(V)"><span class="cb ${XP.tags.has(t)?'on':''}">${XP.tags.has(t)?ic('check',11,2):''}</span>${t}</span>`).join('')}</div>
     <div class="xh">参考文献</div>
     ${cbx(XP.refs,'文末附参考文献列表','每篇一行：作者, 年份, 标题；有 DOI 时附链接',"XP.refs=!XP.refs")}
    </div>
    <div class="grow col" style="padding:14px 16px;min-width:0"><div class="row" style="justify-content:space-between;margin-bottom:8px"><span style="font-size:12px;font-weight:600;color:var(--text2)">预览</span><span class="t3" style="font-size:11.5px">${GNAME}.md</span></div><pre class="mdpre">${md}</pre></div></div>
   <div class="row" style="padding:12px 20px;border-top:1px solid var(--line);gap:8px"><div class="grow"></div><button class="btn bordered" onclick="go('/02')">取消</button><button class="btn primary" onclick="go('/02');setTimeout(()=>toast('已导出 Markdown（原型）'),50)">导出…</button></div>
  </div></div>`;
}
/* ---------- 03 paper detail (D18, D29) ---------- */
function detail(k,state){
  if(!S.pos) layout(); if((P[k].failed||P[k].dfail)&&!state) state='failed'; if(P[k].proc&&!state) state='parsing'; const np=P[k].nopdf; window.DST=state; window.DK=k;
  app.innerHTML=`<div class="maincol"><div class="toolbar">${tbLights(false)}
    <button class="btn" onclick="go('/02')" style="color:var(--text2);padding-left:6px">${ic('back',15)}${GNAME}</button><span class="t3" style="margin:0 2px">/</span><span class="ttl" style="margin-left:4px">${P[k].s}</span>
    <div class="grow"></div>${jobsBtn()}<button class="btn icon ${S.chat?'on':''}" onclick="S.chat=!S.chat;route()" title="对话">${ic('chat')}</button></div>
   <div class="ws"><div class="dpage">${np?noPdf(k):state==='parsing'?taskView(k,'parsing'):state==='failed'?taskView(k,'failed'):state==='detail'?taskView(k,'detail'):detailBody(k)}</div>${S.chat?chatDrawer(np?'nopdf':k==='C'?'paper':'pother'):''}</div></div>`;
  afterDrawer();
}
function head(k){return `<div class="h1" style="font-size:22px;line-height:30px">${P[k].t}</div>
  <div class="dmeta"><span>${P[k].a}</span><span class="s">·</span><span>YYYY</span><span class="s">·</span><span>发表于 —</span><span class="s">·</span><span>DOI ${DOI[k]?DOI[k]+'（示例）':'—'}</span><span class="s">·</span><span class="s">Zotero 导入 · item key 示例</span></div>`}
function detailBody(k){
  return `<div class="dcol">${head(k)}
   <div class="dbar"><button class="btn bordered" onclick="go('/07')">${ic('doc',14)}打开 PDF</button>
    <div class="grow"></div><span class="t3 sm">deepseek-flash · 生成于 —</span>
    <button class="btn" style="color:var(--text2)" onclick="regenConfirm()">${ic('rewrite',14)}重新生成</button></div>
   <div class="stale" id="stale">${ic('info',14)}<span class="grow">可能已过期：PDF 已更换为新版本。详情不会自动更新。</span><span class="linkbtn" onclick="regenConfirm()">重新生成</span><span class="t3" style="cursor:pointer" onclick="$('#stale').remove()">${ic('x',13)}</span></div>
   ${absBlock()}
   <div class="prose"><div class="note0">示例内容 · 由 Agent 基于 MinerU 解析结果撰写，非论文真实结论</div>${k!=='C'?`<h3>它在解决什么问题</h3><p>示例占位：这里显示 Agent 为「${P[k].s}」撰写的详情解读全文（问题、方法、结论、局限）。</p></div></div>`:`
    <h3>它在解决什么问题</h3><p>检索增强的搜索智能体需要在每一步决定继续检索还是作答。停得太早会出现「以为已经找全」的错觉式完成，停得太晚则浪费检索预算，并可能引入噪声证据。这篇论文关注的正是这个停止决策。</p>
    <h3>方法</h3><p>论文把停止看成一个验证问题：每轮检索后，由验证器评估当前证据能否支撑候选答案，得到分数 v；当分数达到阈值 τ 时停止，否则继续检索（示例描述）。</p>
    <div class="formula"><span><i>v</i>(<i>q</i>, <i>D<sub>t</sub></i>) ≥ <i>τ</i></span><span class="no">(1)</span></div>
    <div class="fblk" onclick="go('/07')" style="margin-top:4px"><div class="im" style="padding:18px">${figSvg(440)}</div><div class="cp"><span>图 2 · 方法总览（原图占位，取自 MinerU 解析缓存）</span><span class="t3">p.4 · 在 PDF 中查看 ›</span></div></div>
    <p>与只依赖模型自评置信度的做法相比，这种做法把「是否足够」交给独立的验证信号。下表是与几类常见停止策略的定性对比：</p>
    <table><tr><th>停止策略（示例）</th><th>依据</th><th>主要风险</th></tr><tr><td>固定步数</td><td>预设检索轮数</td><td>与问题难度无关</td></tr><tr><td>模型自评置信度</td><td>模型自身判断</td><td>容易过度自信</td></tr><tr><td>验证感知（本文）</td><td>验证器分数与阈值 τ</td><td>依赖验证器质量</td></tr></table>
    <h3>结论</h3><p>示例：在若干多跳问答设置下，验证感知停止在保持答案质量的同时减少了不必要的检索轮数。具体数值以原文表格为准。</p>
    <h3>局限</h3><p>示例：阈值 τ 需要按任务调节；验证器本身出错时，停止决策会随之出错。这一点可以与 CAS 用 conformal 方法校准阈值的做法对照阅读。</p>
   </div></div>`}`;
}
/* 03b / 03d / 03h: one processing task per paper = MinerU 解析 → 生成名片 → 生成详情 (D67). Failure comes from status polling (D73). */
function taskView(k,mode){
  const steps=['MinerU 解析','生成名片','生成详情'];
  const R={health:[0,'MinerU 服务无响应','状态查询连续失败，自动重启服务一次后仍未恢复。'],timeout:[0,'超过预计时长','MinerU 任务一直没有完成，已超过按页数估算的时长，已停止。'],exit:[0,'MinerU 进程意外退出','解析进程退出，任务未完成。'],card:[1,'生成名片失败','模型返回的内容不完整（示例）。'],detail:[2,'生成详情失败','模型返回的内容不完整（示例）。']};
  const fr=R[Q.get('reason')]||(P[k].dfail?R.detail:R.health);
  const llm=fr[0]>0;
  const cur=mode==='parsing'?0:mode==='detail'?2:fr[0];
  const stTxt=i=>i<cur?'完成':i>cur?'等待':mode==='failed'?'失败':i===0?'解析中':'生成中…';
  const icon=i=>i<cur?ic('check',14):i>cur?'<span style="width:14px"></span>':mode==='failed'?ic('close',14):'<span class="zdot" style="background:var(--accent);margin:0 4px"></span>';
  const title=mode==='failed'?`<div class="row" style="gap:8px;font-size:14px;font-weight:600"><span class="zdot" style="background:var(--danger)"></span>处理失败 · ${fr[1]}</div>`
    :`<div style="font-size:14px;font-weight:600">${mode==='parsing'?'正在解析 PDF':'正在生成详情'}</div>`;
  const sub=mode==='failed'?`<div class="t2 sm" style="margin-top:-6px;line-height:19px">${fr[2]}${llm?'已自动重试 3 次，仍未成功。':''}<br>失败在「${steps[cur]}」这一步（第 ${cur+1} / 3 步）· 今天 HH:MM（示例）</div>`
    :mode==='parsing'?`<div class="row sm" style="gap:8px;margin-top:-6px"><span class="t2">MinerU 任务状态：解析中</span><span class="t3" style="font-size:11px">页级进度待 M0 验证</span></div>`
    :`<div class="t2 sm" style="margin-top:-6px">解析完成后会自动生成详情，完成后这里直接显示。</div>`;
  return `<div class="dcol">${head(k)}<div class="dbar"><button class="btn bordered" ${mode==='parsing'?'disabled style="opacity:.5"':'onclick="go(\'/07\')"'}>${ic('doc',14)}打开 PDF</button><div class="grow"></div></div>
   <div style="margin-top:40px;max-width:420px;margin-left:auto;margin-right:auto;display:flex;flex-direction:column;gap:14px">
    ${title}${sub}
    <div class="tsteps">${steps.map((n,i)=>`<div class="${i<cur?'done':i===cur?(mode==='failed'?'fail':'cur'):''}"><span class="ti">${icon(i)}</span><span class="grow">${n}</span><span class="ts">${stTxt(i)}</span></div>`).join('')}</div>
    ${mode==='failed'?(llm?`<div class="row" style="gap:10px"><button class="btn primary" onclick="toast('从「${steps[cur]}」这一步接着重试（原型）')">${ic('rewrite',14)}重试</button><span class="t3" style="font-size:11.5px">已自动重试 3 次 · 从这一步接着重试，前面已完成的步骤不重做</span></div>`:`<div class="row" style="gap:10px"><button class="btn primary" onclick="go('/03b?paper=${k}')">${ic('rewrite',14)}重试</button><span class="t3" style="font-size:11.5px">MinerU 解析失败不会自动重试，点「重试」手动重新解析</span></div>`):''}</div></div>`;
}
function regenConfirm(){
  const o=document.createElement('div'); o.className='ov'; o.id='regen'; o.onclick=e=>{if(e.target===o)o.remove()};
  o.innerHTML=`<div class="modal cfm"><div style="font-size:14px;font-weight:600">重新生成详情？</div>
   <div class="t2" style="font-size:12.5px;line-height:19px;margin-top:6px">会用当前 PDF 和 prompt 重新生成，并覆盖现在的详情。</div>
   <div class="row" style="justify-content:flex-end;gap:8px;margin-top:18px"><button class="btn bordered" onclick="$('#regen').remove()">取消</button><button class="btn primary" onclick="$('#regen').remove();toast('正在重新生成（原型）')">重新生成</button></div></div>`;
  $('.maincol').appendChild(o);
}
/* ---------- 07 PDF reader (D27) ---------- */
function reader(){
  const th=n=>`<div class="thumb ${n===4?'on':''}">${Array.from({length:n===1?12:16},(_,i)=>`<i style="width:${[100,96,88,100,70,100,92,0,100,84,100,96,60,100,90,80][i]}%;${n===4&&i>=8&&i<=11?'background:rgba(47,111,235,.35)':''}"></i>`).join('')}</div><div class="tno">${n}</div>`;
  app.innerHTML=`<div class="rside">${lights}<div style="padding:0 12px 6px"><span class="seg" style="width:100%;display:flex"><span class="on" style="flex:1;text-align:center">缩略图</span><span style="flex:1;text-align:center">目录</span><span style="flex:1;text-align:center">标注</span></span></div>
   <div class="thumbs">${[2,3,4,5].map(th).join('')}</div></div>
  <div class="maincol"><div class="toolbar">
    <button class="btn" onclick="go('/03?paper=C')" style="color:var(--text2);padding-left:6px">${ic('back',15)}论文详情</button><span class="t3" style="margin:0 2px">/</span><span class="ttl" style="margin-left:4px">HALT.pdf</span>
    <div class="grow"></div><span class="t3 sm" style="margin-right:6px">4 / 14</span><div class="sep"></div><span class="t3 sm" style="margin:0 6px">−　100%　+</span><div class="sep"></div>
    <button class="btn icon on" title="高亮">${ic('marker',15)}</button><button class="btn icon" title="笔记">${ic('note',15)}</button><div class="sep"></div>${jobsBtn()}
    <button class="btn icon ${S.chat?'on':''}" onclick="S.chat=!S.chat;route()" title="对话">${ic('chat')}</button></div>
   <div class="ws"><div class="rmain"><div class="page">
    <div class="rh"><span>示例排版 · 非论文原文</span><span>4</span></div>
    <h4>4&nbsp;&nbsp;Method</h4>
    <p>We consider a search agent that interleaves retrieval and reasoning. At step <i>t</i> the agent holds a query <i>q</i> and an evidence set <i>D<sub>t</sub></i>, and must decide whether to issue another retrieval call or to commit to an answer. <span class="hl">Our key observation is that this decision can be framed as verification rather than self-assessment.</span></p>
    <p>Concretely, a lightweight verifier scores whether the current evidence supports the candidate answer. <span class="selx">The agent stops once the verifier score exceeds τ, and otherwise continues to retrieve.</span> This replaces a fixed step budget with a signal that adapts to question difficulty.</p>
    <p>We describe the verifier in Section 4.1 and the choice of the threshold in Section 4.2. Placeholder sentences follow to illustrate the layout of a typical two-paragraph method section in the reader view.</p>
    <div class="pfig">${figSvg(400)}<div class="c">Figure 2: Overview of the method (placeholder).</div></div>
    <h4 style="font-size:13px">4.1&nbsp;&nbsp;Verifier</h4>
    <p>The verifier receives the query, the candidate answer and the retrieved passages, and outputs a scalar score. Placeholder text continues here to fill the page with realistic line lengths and paragraph rhythm for the prototype.</p>
    <p>Placeholder text continues. Placeholder text continues here to fill the page with realistic line lengths and paragraph rhythm for the prototype view of the reader.</p>
    <div class="selpop" style="left:150px;top:268px"><button class="btn">${ic('marker',14)}高亮</button><button class="btn">${ic('note',14)}笔记</button><button class="btn" style="color:var(--accent)">${ic('chat',14)}发给 agent</button></div>
    <div class="nmark" style="left:534px;top:150px">${ic('note',11,1.6)}</div>
       </div>
   <div class="ncard" style="right:12px;top:150px;width:146px"><div class="k">我的笔记 · p.4</div>和 CAS 的 conformal 阈值对比：这里的 τ 是手动设定的吗？</div>
   </div>${S.chat?chatDrawer('reader'):''}</div></div>`;
  afterDrawer();
}
/* ===== v4.3 additions ===== */
Object.assign(I,{grip:'<circle cx="6" cy="4" r=".7"/><circle cx="10" cy="4" r=".7"/><circle cx="6" cy="8" r=".7"/><circle cx="10" cy="8" r=".7"/><circle cx="6" cy="12" r=".7"/><circle cx="10" cy="12" r=".7"/>',
 drop:'<path d="M8 2.5v7.5M5 7l3 3 3-3"/><path d="M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2"/>'});
/* global background-task status (topbar). ok = quiet grey dot; queue = neutral + count; fail = red + count */
/* D70 states: queued / running / waiting_network / waiting_key / failed_retryable / failed_action. One paper = one processing task; card + detail are steps of it. */
const JOBG={
 fail:[['需处理失败','f',[{t:'API Key 无效 · 影响 4 个任务',r:'DeepSeek 返回 401，LLM 队列已暂停',go:'/05?sec=gen'},{t:'ReSearch 处理失败 · 在 MinerU 解析这一步',r:'MinerU 服务无响应 · 需手动重试',btn:1},{t:'ReAct 处理失败 · 在生成详情这一步',r:'模型返回的内容不完整（示例）· 已自动重试 3 次 · 从这一步接着重试',btn:1}]],
   ['可重试失败','f',[{t:'获取引用 · BrowseComp-Plus',r:'OpenAlex 请求超时 · 已自动重试 3 次',btn:1}]],
   ['运行中','r',[{t:'RAG（Lewis et al.）处理中 · MinerU 解析',r:'第 1 / 3 步 · 不需要 LLM，不受暂停影响'}]],
   ['排队中','q',[{t:'生成关系 · 本图谱',r:'LLM 队列暂停中，Key 修复后继续'}]]],
 queue:[['等待 Key','q',[{t:'生成关系 · 本图谱',r:'还没有填写 DeepSeek API Key',go:'/05?sec=gen'}]],
   ['等待网络','q',[{t:'获取引用 · 6 篇',r:'当前离线，联网后自动继续；离线不消耗重试次数'}]],
   ['运行中','r',[{t:'RAG（Lewis et al.）处理中 · MinerU 解析',r:'第 1 / 3 步'}]]]};
const jobN=()=>JOBS==='fail'?JOBG.fail.filter(g=>g[1]==='f').reduce((a,g)=>a+g[2].length,0):JOBS==='queue'?JOBG.queue.reduce((a,g)=>a+g[2].length,0):0;
function jobsBtn(){const n=jobN();
  return `<button class="jobs ${JOBS}" data-pop onclick="jobsPop(this)" title="后台任务"><i></i>${n?`<span>${n}</span>`:''}</button>`}
function jobsPop(btn){ if(!btn) return; closePops();
  const row=(x,kind)=>`<div class="jrow"><span class="jd ${kind}"></span><div class="grow"><div class="jt">${x.t}</div><div class="jr">${x.r}</div></div>${x.go?`<span class="linkbtn" onclick="go('${x.go}')">去设置</span>`:x.btn?`<button class="btn sm bordered" onclick="toast('已重新加入队列（原型）')">重试</button>`:''}</div>`;
  let h=`<div class="jh"><b>后台任务</b><span class="grow"></span>${JOBS==='fail'?'<span class="paused">LLM 队列已暂停</span>':''}</div>`;
  const G=JOBG[JOBS];
  if(G) h+=G.map(g=>`<div class="jsec">${g[0]} · ${g[2].length}</div>${g[2].map(x=>row(x,g[1])).join('')}`).join('');
  else h+=`<div class="t3 sm" style="padding:14px 4px 10px">没有进行中或失败的任务。</div>`;
  h+=`<div class="jfoot">MinerU 解析失败需手动重试；名片、详情失败会先自动重试 3 次，再从失败的那一步接着重试。其他任务自动重试 3 次。处理失败的论文不参与关系生成，不影响其他论文。</div>`;
  const r=btn.getBoundingClientRect(),a=app.getBoundingClientRect(); const m=document.createElement('div'); m.className='pop jobpop';
  m.style.left=Math.max(12,Math.min(a.width-412,r.left-a.left-200))+'px'; m.style.top=(r.bottom-a.top+6)+'px'; m.innerHTML=h; app.appendChild(m);
}
/* agent candidate that is already in the paper library */
function libCard(k){return `<div class="ccard"><div class="row" style="gap:8px"><div class="t grow">${P[k].t}</div></div><div class="m">${P[k].a} · YYYY · <span class="inlib">已在论文库中</span></div><div class="r">${P[k].why}</div>
  <div class="acts"><span class="t3 grow" style="font-size:11.5px;align-self:center">已有 PDF，不会重复下载</span><button class="btn sm">忽略</button><button class="btn sm bordered" style="color:var(--accent)" onclick="toast('已加入图谱（原型）')">加入图谱</button></div></div>`}
/* chat message that failed midway: keep generated text, show error + retry */
function chatErr(){return {ei:'doc',el:'对象',en:'论文 · HALT',cost:'0.11',chips:[],input:'问问这篇论文…',body:`
  <div class="mu"><div class="chipline"><span class="chip">${ic('doc',12)}<span>CAS</span></span></div>HALT 的停止判据和 CAS 有什么不同？配张图说明。</div>
  ${trace('p1',[['读了 CAS 名片'],['读了 HALT 详情'],['读了 HALT §3 原文'],['读了 HALT 图 2']])}
  <div class="ma"><div>示例回答：两者都在每一步判断证据是否足够。HALT 用验证器给出的分数与阈值 τ 比较，分数达到 τ 就停止；CAS 则用</div>
   <div class="merr"><span class="edot0"></span><span class="grow">生成中断：网络连接超时。上面是已生成的部分。</span><button class="btn sm bordered" onclick="toast('重新生成这条回答（原型）')">${ic('rewrite',13)}重试</button></div></div>`}}
/* abstract block on 03: original Abstract, or AI-generated with a tiny tag (abs=ai) */
function absBlock(){const ai=Q.get('abs')==='ai';
  return `<div class="abs"><div class="absh"><span>摘要</span>${ai?'<span class="aitag" title="论文元数据和 PDF 中没有找到原文 Abstract，由 Agent 根据正文生成">AI 生成</span>':'<span class="t3" style="font-weight:400">原文 Abstract</span>'}</div>
   <div class="abt">${ai?'示例：这篇论文研究检索增强搜索智能体何时停止检索。作者把停止决策看作验证问题，用验证器分数和阈值决定继续检索还是作答，并与固定步数、模型自评等策略对比。':'Placeholder abstract (示例占位，非论文原文). Search agents must decide at every step whether to keep retrieving or to commit to an answer. We frame this decision as verification and … The original abstract text from the PDF / metadata is shown here unchanged.'}</div></div>`}
/* 03e: paper without PDF — metadata only + drop zone */
function noPdf(k){const kv=(a,b)=>`<span>${a}</span><span>${b}</span>`;
  return `<div class="dcol"><div class="h1" style="font-size:22px;line-height:30px">${P[k].t}</div>
   <div class="dmeta"><span class="nptag">无 PDF</span><span class="s">不参与关系生成，也没有详情解读</span></div>
   <div class="kv npkv">${kv('作者',P[k].a)}${kv('年份','YYYY')}${kv('DOI','—')}${kv('发表于','—')}${kv('来源','Zotero 导入 · item key 示例（条目没有附带 PDF）')}</div>
   <div class="dropz">${ic('drop',22,1.3)}<div style="font-size:13.5px;color:var(--text);margin-top:8px">把 PDF 拖到这里</div><div class="t3 sm" style="margin-top:2px">或 <span class="linkbtn" style="font-size:12px">选择文件…</span></div>
    <div class="t2 sm" style="margin-top:14px">拖入并解析后，会自动生成详情，并为这篇论文补上关系。</div></div>
   <div class="tried"><span class="grow">尝试过的来源：开放获取（arXiv / OpenAlex / Unpaywall），都未找到（今天 HH:MM，示例）</span><button class="btn bordered sm" onclick="toast('正在按来源顺序重新查找（原型）')">${ic('rewrite',13)}再试一次查找</button></div>
   <div class="t3" style="font-size:11.5px;margin-top:8px">查找顺序可在 <span class="linkbtn" style="font-size:11.5px" onclick="go('/05?sec=pdf')">设置 › PDF 来源</span> 中调整。</div></div>`}
/* 10: first build of a graph */
const BX={parse:true,card:false,det:false,cite:false,rel:false};
function buildPage(){
  const big=Q.get('scale')==='big'; if(big&&!BX._b){BX.parse=false;BX._b=1;} const ok=['C','D','A','B','E','F'], row=(k,ic0,txt)=>`<div class="bp"><span class="bi">${ic0}</span><span class="grow">${P[k].s}</span><span class="t3">${txt}</span></div>`;
  const stage=(id,n,state,cnt,body)=>`<div class="bst ${state}"><div class="bsh" onclick="BX.${id}=!BX.${id};buildPage()"><span class="bi">${state==='done'?ic('check',14):state==='cur'?'<span class="zdot" style="background:var(--accent)"></span>':'<span class="zdot" style="background:var(--line2)"></span>'}</span><span class="nm">${n}</span><span class="grow"></span><span class="cnt">${cnt}</span><span class="t3">${ic(BX[id]?'chevD':'chevR',13)}</span></div>${BX[id]?`<div class="bpl">${body}</div>`:''}</div>`;
  const parse=ok.map(k=>row(k,ic('check',13),'已解析')).join('')+`<div class="bp"><span class="bi"><span class="edot0"></span></span><span class="grow">ReSearch<span class="t3">　MinerU 服务无响应</span></span><button class="btn sm bordered" onclick="toast('重试 ReSearch 的处理任务（原型）')">重试</button></div>
    <div class="bp"><span class="bi"><span class="npsw"></span></span><span class="grow">Self-RAG<span class="t3">　无 PDF</span></span><span class="t3">不参与关系生成</span></div>`;
  const card=ok.map(k=>row(k,ic('check',13),'已生成')).join('');
  const det=ok.slice(0,3).map(k=>row(k,ic('check',13),'已生成')).join('')+row('B','<span class="zdot" style="background:var(--accent)"></span>','生成中…')+ok.slice(4).map(k=>row(k,'','等待')).join('');
  const wait=t=>`<div class="bp"><span class="bi"></span><span class="grow t3">${t}</span></div>`;
  app.innerHTML=`<div class="maincol"><div class="toolbar">${tbLights(false)}
    <button class="btn" onclick="go('/01')" style="color:var(--text2);padding-left:6px">${ic('back',15)}我的图谱</button><span class="t3" style="margin:0 2px">/</span><span class="ttl" style="margin-left:4px">${GNAME}</span>
    <div class="grow"></div>${jobsBtn()}</div>
   <div class="ws"><div class="dpage" style="background:var(--canvas)"><div class="bcol">
    <div style="font-size:17px;font-weight:600">正在建图</div>
    <div class="t3" style="font-size:12.5px;margin-top:4px">${big?'150 篇论文（示例）':'8 篇论文'} · 来自 Zotero 分类 Benchmarks（示例）</div>
    <div class="prog" style="margin-top:16px"><i style="width:52%"></i></div>
    ${big?`<div class="bhint">${ic('info',14)}<span>论文较多，将先用名片建底图再逐篇补充</span></div>`:''}
    <div class="bstages">
     ${stage('parse','解析 PDF','done',big?'148 / 149 · <span class="fail">1 篇失败</span> · 1 篇无 PDF':'6 / 7 · <span class="fail">1 篇失败</span> · 1 篇无 PDF',parse)}
     ${stage('card','生成名片','done',big?'148 / 148':'6 / 6',card)}
     ${stage('det','生成详情','cur',big?'61 / 148':'3 / 6',det)}
     ${stage('cite','获取引用','','等待',wait(`从 OpenAlex 获取解析成功的 ${big?148:6} 篇的参考文献（referenced_works）`))}
     ${stage('rel','生成关系','','等待',wait(big?'先用名片建底图，再逐篇按「新增论文」流程补充关系':'只在解析和详情都成功的论文之间生成；Self-RAG（无 PDF）和 ReSearch（处理失败）不参与'))}
    </div>
    <div class="t3" style="font-size:12px;margin-top:10px">生成关系：等所有论文处理完成或失败后开始</div>
    <div class="bfail"><span class="edot0"></span><span class="grow">1 篇处理失败，未参与建图，重试成功后会补进图里<span class="t3" style="display:block;font-size:11.5px">ReSearch · 在 MinerU 解析这一步失败（MinerU 服务无响应），需手动重试；其他论文照常建图</span></span><button class="btn bordered sm" onclick="toast('重试 ReSearch 的处理任务（原型）')">${ic('rewrite',13)}重试</button></div>
   </div></div></div></div>`;
}
/* 02: node context menu (D75: remove from graph ≠ delete from library) */
function nodeMenu(k){const n=document.querySelector(`.node[data-k="${k}"]`); if(!n) return; closePops(); tip(k,0);
  const r=n.getBoundingClientRect(),a=app.getBoundingClientRect(); const m=document.createElement('div'); m.className='menu';
  m.style.left=(r.right-a.left-36)+'px'; m.style.top=(r.top-a.top+18)+'px';
  m.innerHTML=`<div class="cap" style="padding:6px 10px 4px">${P[k].s}</div>
   <div class="mi" onclick="go('/03?paper=${k}')">${ic('doc',15)}打开详情</div>
   <div class="mi" onclick="go('/07')">${ic('ext',15)}打开 PDF</div>
   <div class="mi" onclick="closePops();toast('已在对话中提及 ${P[k].s}（原型）')">${ic('at',15)}在对话中提及</div><div class="ms"></div>
   <div class="mi" onclick="closePops();toast('已从图谱移除 · 论文仍在论文库 · ⌘Z 撤销')">${ic('close',15)}从图谱移除<span class="kb">仍在论文库</span></div>
   <div class="mi" style="color:var(--danger)" onclick="go('/02?del=${k}')">${ic('trash',15)}从库删除…</div>`;
  m.style.minWidth='220px'; app.appendChild(m);
}
function delDlg(k){const n=S.edges.filter(e=>e.s===k||e.t===k).length;
  return `<div class="ov" onclick="if(event.target===this)go('/02')"><div class="modal cfm" style="width:400px">
   <div style="font-size:14px;font-weight:600">从论文库删除「${P[k].s}」？</div>
   <div class="t2" style="font-size:12.5px;line-height:19px;margin-top:6px">这篇论文会从论文库和所有图谱中移除，本图谱里和它相连的 ${n} 条关系也会一并移除。</div>
   <div class="t3" style="font-size:11.5px;line-height:17px;margin-top:8px">只想从这张图谱里拿掉？用「从图谱移除」，论文仍留在论文库。</div>
   <div class="row" style="justify-content:flex-end;gap:8px;margin-top:18px"><button class="btn bordered" onclick="go('/02')">取消</button><button class="btn dfill" onclick="go('/02');setTimeout(()=>toast('已从论文库删除（原型）'),50)">从库删除</button></div></div></div>`}
/* 02e: regenerate relations (D88) — auto-generated relations are not in ⌘Z, so confirm twice */
function regenRelDlg(){const n=S.edges.length;
  return `<div class="ov" onclick="if(event.target===this)go('/02')"><div class="modal cfm" style="width:420px">
   <div style="font-size:14px;font-weight:600">重新生成本图的关系？</div>
   <div class="t2" style="font-size:12.5px;line-height:19px;margin-top:6px">会替换本图自动生成的关系（现有 ${n} 条），不能用 ⌘Z 撤销。</div>
   <div class="t3" style="font-size:11.5px;line-height:17px;margin-top:8px">按当前论文的详情重新生成；未参与关系的论文（无 PDF、处理中、处理失败）仍不参与。</div>
   <div class="row" style="justify-content:flex-end;gap:8px;margin-top:18px"><button class="btn bordered" onclick="go('/02')">取消</button><button class="btn dfill" onclick="go('/02');setTimeout(()=>toast('正在重新生成关系（原型）'),50)">重新生成</button></div></div></div>`}
/* 02f: quit confirmation while background tasks are running (D36) */
function quitDlg(){const n=Q.get('idle')?0:JOBG.fail.filter(g=>g[1]!=='f').reduce((a,g)=>a+g[2].length,0);
  return `<div class="ov"><div class="modal cfm" style="width:380px">
   <div style="font-size:14px;font-weight:600">退出 Graphictero？</div>
   ${n?`<div class="t2" style="font-size:12.5px;line-height:19px;margin-top:6px">还有 ${n} 个任务在运行，退出后下次启动会继续。</div>
   <div class="t3" style="font-size:11.5px;line-height:17px;margin-top:6px">退出后撤销历史将被清空</div>`
   :`<div class="t2" style="font-size:12.5px;line-height:19px;margin-top:6px">退出后撤销历史将被清空</div>`}
   <div class="row" style="justify-content:flex-end;gap:8px;margin-top:18px"><button class="btn bordered" onclick="go('/02')">取消</button><button class="btn primary" onclick="go('/02');setTimeout(()=>toast('已退出（原型）'),50)">退出</button></div></div></div>`}
/* 00: first launch — MinerU install, just a progress bar (D82) */
function firstRun(){
  app.innerHTML=`<div class="maincol"><div class="toolbar" style="border-bottom:none">${tbLights(false)}</div>
   <div class="ws"><div class="frun"><div class="fr-t">正在安装解析组件（MinerU）</div>
    <div class="prog" style="margin-top:18px"><i style="width:42%"></i></div>
    <div class="row t3" style="justify-content:flex-end;font-size:11.5px;margin-top:6px">42%（示例）</div>
    <div class="t2" style="font-size:12.5px;margin-top:10px;line-height:19px"><span style="display:block">Graphictero 首次启动会在本机安装 Python 和 MinerU，</span><span style="display:block">并下载模型文件（几 GB），只需一次。</span></div>
   </div></div></div>`;
}

route();
