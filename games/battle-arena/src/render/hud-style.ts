/** The HUD stylesheet, injected once by the Hud constructor. */
export const STYLE = `
[hidden]{display:none!important}
#ba-plates{position:absolute;inset:0}
.ba-plate{position:absolute;transform:translate(-50%,-50%);text-align:center;pointer-events:none;will-change:left,top}
.ba-pname{font:700 12px ui-monospace,monospace;text-shadow:0 1px 2px #000;white-space:nowrap}
.ba-php{width:54px;height:5px;margin:2px auto 0;background:rgba(0,0,0,.6);border-radius:3px;overflow:hidden}
.ba-phpfill{height:100%;width:100%;transition:width .12s}
#ba-top{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);text-align:center;pointer-events:none}
#ba-timer{font:800 40px ui-monospace,monospace;color:#ffd24a;text-shadow:0 3px 0 rgba(0,0,0,.5);line-height:1;font-variant-numeric:tabular-nums;pointer-events:auto;cursor:pointer;touch-action:none}
#ba-timer.low{color:#ff5a52}
#ba-goal{font:700 12px ui-monospace,monospace;letter-spacing:2px;opacity:.8;margin-top:4px;text-shadow:0 2px 5px rgba(0,0,0,.9)}
#ba-objective{display:flex;gap:14px;justify-content:center;margin-top:5px;font:700 11px ui-monospace,monospace;letter-spacing:1px;opacity:.85;font-variant-numeric:tabular-nums}
#ba-objective .coin{color:#ffd24a}
#ba-objective .drop{color:#6bffcc}
#ba-objective .live{animation:ba-obj .8s infinite alternate}
@keyframes ba-obj{from{opacity:.6}to{opacity:1}}
#ba-board{position:fixed;top:calc(12px + env(safe-area-inset-top));left:calc(12px + env(safe-area-inset-left));display:flex;flex-direction:column;gap:3px;pointer-events:none}
.ba-row{display:flex;align-items:center;gap:7px;background:rgba(12,16,26,.6);border-radius:6px;padding:3px 9px 3px 6px;font:700 13px ui-monospace,monospace;min-width:150px}
.ba-row.x{min-width:230px}
.ba-row.me{outline:1px solid rgba(70,224,255,.6)}
.ba-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.ba-rn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ba-rk{font-variant-numeric:tabular-nums;opacity:.9}
.ba-rg{font-variant-numeric:tabular-nums;color:#ffd24a}
.ba-ri{font-variant-numeric:tabular-nums;opacity:.65;font-size:11px}
#ba-feed{position:fixed;top:calc(12px + env(safe-area-inset-top));right:calc(12px + env(safe-area-inset-right));display:flex;flex-direction:column;gap:3px;align-items:flex-end;pointer-events:none}
.ba-kill{display:flex;align-items:center;gap:5px;background:rgba(12,16,26,.6);border-radius:6px;padding:3px 9px;font:600 12px ui-monospace,monospace;animation:ba-in .2s}
.ba-kill b{color:#ffd24a}
.ba-kill.leader{outline:1px solid #ffd24a;color:#ffd24a}
.ba-ks{width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,.3)}
.ba-kw{width:13px;height:13px;opacity:.8}
#ba-menu-btn{position:fixed;top:calc(148px + env(safe-area-inset-top));right:calc(64px + env(safe-area-inset-right));height:44px;padding:0 12px;pointer-events:auto;background:rgba(12,16,26,.75);border:1px solid rgba(255,210,74,.4);border-radius:8px;color:#ffd24a;font:800 12px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;z-index:6}
#ba-menu-btn:hover{background:rgba(255,210,74,.15)}
#ba-toasts{position:fixed;top:24%;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.ba-toast{font:800 italic 24px system-ui,sans-serif;letter-spacing:1px;text-shadow:0 2px 8px #000;animation:ba-pop .3s}
.ba-toast.leader{color:#ff5a52}
.ba-toast.delivery{color:#6bffcc}
.ba-toast.streak{color:#ffb13b}
.ba-toast.matchend{color:#ffd24a;font-size:30px}
#ba-bottom{position:fixed;bottom:calc(14px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
#ba-buffs{display:flex;gap:5px;min-height:26px}
.ba-buff{position:relative;width:26px;height:26px;border-radius:6px;overflow:hidden;border:1px solid rgba(107,255,142,.7);background:rgba(10,14,24,.7)}
.ba-buff.debuff{border-color:rgba(255,90,82,.8)}
.ba-buff img{position:absolute;inset:0;width:100%;height:100%}
.ba-buff .ba-bglyph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:15px}
.ba-buff .ring{position:absolute;inset:0;background:conic-gradient(transparent calc(var(--t,100)*1%),rgba(5,8,16,.7) 0)}
.ba-buff b{position:absolute;bottom:0;right:1px;font:800 9px ui-monospace,monospace;color:#fff;text-shadow:0 1px 2px #000;font-variant-numeric:tabular-nums}
#ba-vitals{display:flex;flex-direction:column;gap:0;width:340px}
#ba-vrow{display:flex;gap:8px;align-items:center}
#ba-lvlbadge{width:30px;height:30px;flex:0 0 auto;transform:rotate(45deg);background:#101526;border:2px solid #ffd24a;border-radius:7px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 10px -3px rgba(255,210,74,.7)}
#ba-lvlbadge span{transform:rotate(-45deg);font:800 13px ui-monospace,monospace;color:#ffd24a}
#ba-lvlbadge.lvlup{animation:ba-lvlup .6s}
@keyframes ba-lvlup{30%{transform:rotate(45deg) scale(1.35);box-shadow:0 0 22px rgba(255,210,74,.9)}}
.ba-bar{position:relative;background:rgba(0,0,0,.55);border-radius:5px;overflow:hidden}
.ba-bar.hp{flex:1;height:20px;border:1px solid rgba(255,255,255,.25);border-radius:6px;background:rgba(0,0,0,.6)}
#ba-hpghost{position:absolute;inset:0;width:100%;background:#ff8f6a;opacity:.7}
#ba-hpfill{position:absolute;inset:0;width:100%;transition:none}
#ba-hpfill.hi{background:linear-gradient(180deg,#8df59d,#3fbf55 45%,#2e9440)}
#ba-hpfill.mid{background:linear-gradient(180deg,#ffe08a,#e8a93d 45%,#b97f22)}
#ba-hpfill.low{background:linear-gradient(180deg,#ff9a8a,#e04a3a 45%,#a82f22)}
#ba-ticks{position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.5) 1px,transparent 1px) repeat-x}
.ba-bar.hp span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 11px ui-monospace,monospace;text-shadow:0 1px 1px #000;font-variant-numeric:tabular-nums}
.ba-bar.xp{height:5px;border-radius:3px;margin-top:3px;background:rgba(0,0,0,.55)}
#ba-xpfill{height:100%;width:0;background:linear-gradient(90deg,#b98a1e,#ffd24a);border-radius:3px}
#ba-abilities{display:flex;gap:8px;align-items:flex-end}
.ba-abil{position:relative;width:56px;height:56px;background:#0c101c;border:2px solid rgba(255,255,255,.22);border-radius:11px;overflow:hidden;box-shadow:0 3px 0 rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.6)}
.ba-abil.ult{width:62px;height:62px;border-color:rgba(255,210,74,.55)}
.ba-abil.util{width:44px;height:44px;border-color:rgba(150,200,255,.4)}
.ba-abil-gap{width:10px;flex:0 0 auto}
.ba-abil .ba-ic{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ba-abil.oncd .ba-ic{filter:saturate(.3) brightness(.55)}
.ba-abil.locked .ba-ic{filter:grayscale(1) brightness(.4)}
.ba-abil.locked{opacity:.6}
.ba-cd{position:absolute;inset:0;background:conic-gradient(rgba(5,8,16,.85) calc(var(--cd,0)*1%),transparent 0)}
.ba-key{position:absolute;top:2px;left:2px;padding:1px 5px;border-radius:5px 0 6px 0;background:rgba(5,8,16,.85);font:800 12px ui-monospace,monospace;color:#ffd24a;text-shadow:none}
.ba-cdtext{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 18px ui-monospace,monospace;color:#fff;text-shadow:0 2px 3px #000;font-variant-numeric:tabular-nums}
.ba-pips{position:absolute;bottom:3px;left:0;right:0;display:flex;gap:3px;justify-content:center}
.ba-pips i{width:5px;height:5px;border-radius:1px;background:rgba(255,255,255,.25)}
.ba-pips i.on{background:#ffd24a;box-shadow:0 0 4px #ffd24a}
.ba-abil.ready{animation:ba-ready .4s}
@keyframes ba-ready{0%{box-shadow:0 0 0 0 rgba(255,210,74,.9)}100%{box-shadow:0 0 0 14px rgba(255,210,74,0)}}
/* MOUSE mode (menus own the cursor): swap the gameplay crosshair for a pointer */
body.ba-mouse-mode canvas{cursor:default}
#ba-items{display:flex;gap:5px;min-height:2px}
.ba-item-chip{position:relative;width:40px;height:40px;background:rgba(18,22,34,.8);border:1px solid rgba(255,255,255,.16);border-radius:7px;overflow:hidden;pointer-events:auto;touch-action:none}
.ba-item-chip.active{border-color:rgba(107,255,142,.6)}
.ba-item-chip.active.rdy{box-shadow:0 0 8px -2px #6bff8e}
.ba-item-chip.empty{background:rgba(18,22,34,.5);border-style:dashed;opacity:.5}
.ba-item-chip.empty .ba-ii{display:none}
.ba-ii{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ba-ik{position:absolute;top:0;left:0;padding:0 4px;border-radius:0 0 5px 0;background:rgba(5,8,16,.85);font:700 9px/13px ui-monospace,monospace;color:#ffd24a}
.ba-icd{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(10,14,24,.78);border-top:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center;font:800 12px ui-monospace,monospace;color:#fff}
#ba-meta{display:flex;gap:14px;font:800 15px ui-monospace,monospace}
#ba-gold{color:#ffd24a}
#ba-goal-banner{position:fixed;top:22%;left:50%;transform:translateX(-50%);background:rgba(10,14,24,.7);border:1px solid rgba(255,210,74,.3);border-radius:12px;padding:12px 20px;font:700 18px ui-monospace,monospace;color:#fff;text-shadow:0 2px 8px #000;white-space:nowrap;pointer-events:none;transition:opacity .5s}
#ba-goal-banner b{color:#ffd24a}
#ba-hint{position:fixed;bottom:calc(206px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);font:700 16px ui-monospace,monospace;color:#fff;text-shadow:0 2px 6px #000;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .3s}
#ba-hint.show{opacity:1}
#ba-hint b{color:#ffd24a}
#ba-intro{position:fixed;top:32%;left:50%;transform:translate(-50%,-50%);font:900 italic 72px system-ui,sans-serif;color:#fff;text-shadow:0 6px 0 rgba(0,0,0,.5),0 0 40px rgba(255,210,74,.25);pointer-events:none;z-index:9;opacity:0}
#ba-intro.show{opacity:1}
#ba-intro.fight{color:#ffd24a}
#ba-intro.small{font-size:26px;letter-spacing:2px;font-style:normal}
#ba-intro.pop{animation:ba-pop .3s}
.ba-arrow{position:fixed;left:0;top:0;font:900 20px system-ui,sans-serif;text-shadow:0 2px 6px #000;pointer-events:none;will-change:transform;z-index:6;opacity:0;transition:opacity .15s}
.ba-arrow.on{opacity:.95}
#ba-arrow-coin{color:#ffd24a}
#ba-arrow-delivery{color:#6bffcc}
#ba-reticle{position:fixed;left:50%;top:50%;width:26px;height:26px;transform:translate(-50%,-50%);pointer-events:none;z-index:6;display:none}
#ba-reticle.show{display:block}
#ba-reticle i{position:absolute;background:rgba(255,255,255,.85);box-shadow:0 0 2px #000;transition:transform .09s,background .1s}
#ba-reticle i:nth-child(1){left:12px;top:0;width:2px;height:7px}
#ba-reticle i:nth-child(2){left:12px;bottom:0;width:2px;height:7px}
#ba-reticle i:nth-child(3){left:0;top:12px;width:7px;height:2px}
#ba-reticle i:nth-child(4){right:0;top:12px;width:7px;height:2px}
#ba-reticle b{position:absolute;left:12px;top:12px;width:2px;height:2px;background:rgba(255,255,255,.9);box-shadow:0 0 2px #000}
#ba-reticle.fire i{transform:scale(1.3)}
#ba-reticle.hit i{background:#ffd24a}
#ba-reticle.hitcrit i{background:#ff5a52;transform:scale(1.5)}
#ba-hitdir{position:fixed;left:50%;top:50%;width:240px;height:240px;margin:-120px;border-radius:50%;pointer-events:none;z-index:6;opacity:0;background:conic-gradient(from calc(var(--a,0deg) - 30deg),transparent 0deg,rgba(255,60,48,.75) 30deg,transparent 60deg);-webkit-mask:radial-gradient(circle,transparent 62%,#000 63%,#000 78%,transparent 79%);mask:radial-gradient(circle,transparent 62%,#000 63%,#000 78%,transparent 79%)}
#ba-minimap{position:fixed;right:calc(12px + env(safe-area-inset-right));bottom:calc(12px + env(safe-area-inset-bottom));width:150px;height:132px;opacity:.92;pointer-events:none;filter:drop-shadow(0 0 10px rgba(0,0,0,.65))}
#ba-respawn{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(40,10,10,.3),rgba(8,8,12,.7));pointer-events:none}
.ba-rtitle{font:900 italic 56px system-ui,sans-serif;color:#ff5a52;text-shadow:0 4px 0 rgba(0,0,0,.5)}
.ba-rslain{font:600 14px ui-monospace,monospace;color:#ff9a94;margin-top:6px}
.ba-rwrap{position:relative;width:72px;height:72px;margin-top:14px}
.ba-rring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(#ffd24a calc(var(--cd,0)*1%),rgba(255,255,255,.12) 0);-webkit-mask:radial-gradient(circle,transparent 57%,#000 60%);mask:radial-gradient(circle,transparent 57%,#000 60%)}
.ba-rtimer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 19px ui-monospace,monospace;font-variant-numeric:tabular-nums}
.ba-rtip{font:600 13px ui-monospace,monospace;color:#9fd0ff;margin-top:14px}
#ba-shop{position:fixed;bottom:120px;left:50%;transform:translateX(-50%);width:min(92vw,560px);max-height:46vh;overflow-y:auto;background:rgba(10,14,24,.94);border:2px solid rgba(255,209,71,.4);border-radius:14px;padding:12px;pointer-events:auto;z-index:8}
.ba-shop-head{font:800 16px ui-monospace,monospace;color:#ffd24a;margin-bottom:8px}
.ba-shop-hint{font-size:11px;opacity:.6;font-weight:600}
/* minmax(0,…): grid items default to min-width:auto, so plain 1fr columns
   refuse to shrink below their content and the right column's price is clipped
   by the panel edge on a phone. */
.ba-shop-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px}
.ba-item{display:flex;flex-direction:row;align-items:center;text-align:left;gap:9px;background:rgba(30,36,52,.8);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 9px;color:#fff;cursor:pointer;font-family:ui-monospace,monospace}
.ba-item.afford{border-color:rgba(107,255,142,.6)}
.ba-item:disabled{opacity:.4;cursor:not-allowed}
.ba-si{width:36px;height:36px;border-radius:7px;flex:0 0 auto;border:1px solid rgba(255,255,255,.2);object-fit:cover}
.ba-icol{display:flex;flex-direction:column;gap:2px;min-width:0}
.ba-iname{font-weight:800;font-size:13px}
.ba-item.active-item .ba-iname::after{content:" ⚡";color:#6bffcc}
.ba-idesc{font-size:10px;opacity:.7}
.ba-icost{font-size:12px;color:#ffd24a;font-weight:700;margin-left:auto;flex:0 0 auto}
#ba-end{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(20,16,28,.4),rgba(8,8,14,.85));backdrop-filter:blur(5px);z-index:20}
.ba-end-card{text-align:center;pointer-events:auto}
.ba-end-title{font:900 italic clamp(40px,12vw,90px) system-ui,sans-serif;letter-spacing:-2px;text-shadow:0 6px 0 rgba(0,0,0,.5);animation:ba-endin .5s cubic-bezier(.2,1.4,.4,1)}
.ba-end-title.win{color:#6bff8e;text-shadow:0 0 60px rgba(107,255,142,.5),0 6px 0 rgba(0,0,0,.5)}
.ba-end-title.loss{color:#ff6a6a;text-shadow:0 0 60px rgba(255,106,106,.4),0 6px 0 rgba(0,0,0,.5)}
@keyframes ba-endin{from{transform:scale(.7);letter-spacing:8px;opacity:0}}
.ba-end-sub{font:600 18px ui-monospace,monospace;margin-top:8px;opacity:.9;display:flex;align-items:center;justify-content:center;gap:8px}
.ba-es{width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,.3)}
.ba-end-stats{font:700 15px ui-monospace,monospace;display:flex;gap:18px;justify-content:center;margin-top:14px;opacity:.9}
.ba-end-stats b{color:#ffd24a;font-size:22px;margin-right:3px}
.ba-end-best{font:800 13px ui-monospace,monospace;letter-spacing:2px;margin-top:10px;opacity:.7}
.ba-end-best.nb{color:#ffd24a;opacity:1;animation:ba-pop .4s}
.ba-end-btns{display:flex;gap:12px;justify-content:center;margin-top:26px}
.ba-end-btn{font:800 16px ui-monospace,monospace;letter-spacing:2px;color:#14111a;background:#ffd24a;border:none;border-radius:10px;padding:14px 26px;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.4)}
.ba-end-btn.alt{background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.3)}
@keyframes ba-in{from{opacity:0;transform:translateX(12px)}}
@keyframes ba-pop{from{opacity:0;transform:scale(.7)}}
/* touch mode (any viewport): the touch grid (bottom-right) duplicates the
   ability tiles (icons + cooldown sweeps), so hide the desktop row and pin the
   remaining vitals/belt cluster bottom-LEFT, clear of the 3-column button grid. */
body.ba-touch-on #ba-bottom{left:calc(12px + env(safe-area-inset-left));transform:none;align-items:flex-start}
body.ba-touch-on #ba-abilities{display:none}
body.ba-touch-on #ba-vitals{width:170px}
/* keep the hint and belt clear of the bottom-right button grid */
body.ba-touch-on #ba-hint{bottom:calc(240px + env(safe-area-inset-bottom))}
body.ba-touch-on .ba-item-chip{width:28px;height:28px}
/* the shared @repo/embed pause+mute cluster owns the top-right corner on a
   coarse pointer, so the kill feed starts below it */
body.ba-touch-on #ba-feed{top:calc(76px + env(safe-area-inset-top))}
/* phone compaction — narrow (portrait) OR short (landscape) viewports */
@media (max-width:720px),(max-height:500px){
#ba-board{display:none}
/* the tapped-timer scoreboard drops below #ba-top instead of over it — the
   timer is also the toggle back off, so it has to stay readable */
#ba-board.force{display:flex;top:calc(92px + env(safe-area-inset-top))}
#ba-minimap{display:none}
.ba-abil{width:48px;height:48px}
.ba-abil.ult{width:52px;height:52px}
.ba-abil.util{width:38px;height:38px}
.ba-abil-gap{width:6px}
#ba-vitals{width:250px}
.ba-item-chip{width:32px;height:32px}
.ba-buff{width:22px;height:22px}
#ba-objective{display:none}
#ba-goal-banner{font-size:14px;padding:9px 14px}
#ba-hint{bottom:calc(186px + env(safe-area-inset-bottom));font-size:13px}
#ba-intro{font-size:54px}
#ba-timer{font-size:30px}
.ba-end-sub{font-size:14px;margin-top:4px}
.ba-end-stats{gap:12px;margin-top:8px;font-size:13px}
.ba-end-btns{margin-top:14px}
.ba-end-btn{padding:11px 20px;font-size:14px}
.ba-rtitle{font-size:40px}
}
/* portrait phones: two shop columns leave ~100px for a name + a description,
   so the grid collapses to one readable column and scrolls instead */
@media (max-width:520px){
.ba-shop-grid{grid-template-columns:minmax(0,1fr)}
}
`;
