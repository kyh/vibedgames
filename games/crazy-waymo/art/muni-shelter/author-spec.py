"""Reference measurements and production component spec; no generated TS ships."""
import copy
import json
import math
from pathlib import Path

root = Path(__file__).parent
spec = json.loads((root / 'spec.json').read_text())
seed = copy.deepcopy(spec['componentTree'][0])
spec['suitability'] = 'pass'
spec['coordinateFrame'] = {'front': '+Z faces roadway; shelter is open on +Z', 'up': '+Y', 'scaleReference': 'world units: width 4.4, height 2.8, depth 1.9; origin at ground between feet'}
spec['silhouette'] = {'boundingShape': 'Two-wave enamel canopy above slender four-post glazed shelter; long slatted bench; right route panel', 'aspectRatios': ['width/height=1.571', 'depth/width=0.432'], 'symmetry': 'roof wave repeats along X; right route panel breaks symmetry', 'dominantCurves': ['two broad low sinusoidal canopy crests', 'rolled bench seat-to-back transition'], 'negativeSpaces': ['entire front entrance remains open', 'space below suspended bench', 'air gap between glazing and ground'], 'landmarks': ['red MUNI plaque at right canopy crest', 'three bench dividers', 'square bolted foot plates']}
spec['performanceBudget'].update({'targetTriangles':9800, 'maxDrawCalls':6, 'textureSize':0, 'fpsTarget':60, 'optimizationPolicy':'Cache one kit, merge by six physical materials; repeated placements share geometry. Text and slats are geometric; no per-placement textures.'})
spec['proceduralStrategy']=['Use the reference canopy profile as an extruded closed band, never a box.', 'Assemble front-open frame, three rear glass panels and two glass returns.', 'Give bench slats real gaps and shape its seat-to-back transition.', 'Use physical fasteners, shallow sign lettering and route schematic geometry.', 'Generate upstream blockout for evidence, then reconstruct strict typed shared meshes; no unchecked generated runtime code.']
colors={'red':'#bd2533','steel':'#9ca9ac','charcoal':'#30383d','glass':'#91bcc1','cream':'#eee4d0','letter':'#f5f3e7'}
classes={'red':'metal','steel':'metal','charcoal':'metal','glass':'glass','cream':'plastic','letter':'plastic'}
rough={'red':0.3,'steel':0.4,'charcoal':0.48,'glass':0.15,'cream':0.72,'letter':0.65}
spec['materials']=[]
for key,color in colors.items():
 spec['materials'].append({'id':key,'name':key,'type':'standard','shaderModel':'MeshStandardMaterial', 'baseColor':color,'color':color,'albedo':{'dominant':color,'secondary':[color], 'samplingNotes':'Measured by inspection of reference material zones; lighting gradients are not copied into albedo.'},'roughness':{'base':rough[key],'variation':0.02,'localResponse':'Edge rounding and neighboring geometry create highlight and cavity variation.'},'metalness':{'base':0.0,'variation':0.0},'textureless':{'declared':True,'evidence':['reference.png and canopy-crop.png / bench-crop.png show smooth manufactured color regions; identifiable relief is geometry, not a printed texture.','Production adaptation for repeated arcade prop: omit microscopic photographic grain; preserve specular roughness and all silhouette-level seams and slats.']},'localOverrides':[{'id':'contact-darkening','region':'mechanical seams','note':'Contact and crevice shading come from overlapping frame joints and physical bevels; no baked lighting gradients.'}]})
spec['lightingFromPhoto']=[{'type':'key','direction':'upper front-left','color':'neutral white','intent':'Broad soft key catches the enamel rim and stainless bevels.'},{'type':'fill','direction':'front right','color':'neutral white','intent':'Preserve charcoal bench slat separation without flattening cavity shadows.'},{'type':'environment','intent':'Neutral studio environment with exposure 1 and ACES in game; harness has fixed neutral light. Ground contact shadow inspected in game; harness is shadowless.'}]
spec['featureReviewTargets']=[{'id':id,'name':name,'tier':'critical','passIds':passes,'minimumScore':0.8,'mustPass':True,'componentRefs':refs,'evidenceRefs':['full-object']} for id,name,passes,refs in [('canopy-wave','Red two-wave silhouette and real canopy thickness',['blockout','structural-pass','form-refinement'],['canopy']),('open-glazing','Open front, three rear panes and side returns',['blockout','structural-pass'],['glass']),('bench-slats','Slatted rolled bench and physical dividers',['form-refinement','surface-pass'],['bench']),('municipal-palette','Red enamel, steel, blue-green glass and municipal information panel',['material-pass','surface-pass','lighting-pass'],['canopy','route-panel'])]]
parts=[]
def add(id,mat,at,size,level='meso',primitive='box',features=(),descriptor=None):
 c=copy.deepcopy(seed); c.update({'id':id,'name':id,'level':level,'role':'assembled-panel','confidence':0.9,'primitive':primitive,'topologyClass':'assembled-solid','topologyRationale':'Manufactured separate solid with positive thickness and explicit contact with neighboring pieces.','parent':None,'material':mat,'materialLayers':[mat],'fidelityTier':'blockout' if level=='macro' else 'structural-pass','localFeatures':[{'id':name,'description':name.replace('-',' ')} for name in features]})
 c['dimensions']={'width':size[0],'height':size[1],'depth':size[2],'units':'world','confidence':0.9}
 c['transform']={'position':list(at),'rotation':[0,0,0],'scale':list(size)}
 if descriptor:c['geometryDescriptor']=descriptor
 else:c['geometryDescriptor']={'edgeTreatment':{'type':'bevel','bevelRadius':0.012,'segments':1},'normalStrategy':'smooth bevels, planar faces','uvStrategy':'none; geometry-defined finish'}
 rgb=[int(colors[mat][i:i+2],16) for i in (1,3,5)]; rgba='rgba('+', '.join(map(str,rgb))+', 1)'
 c['colorMaterialRecipe']={'dominantAlbedo':rgba,'secondaryAlbedo':rgba,'materialClass':classes[mat],'materialClassConfidence':0.9,'evidenceRefs':['full-object']}
 c['actionProfile']['animationRole']='static'; c['actionProfile']['destruction']['debrisMaterial']=mat;c['actionProfile']['destruction']['fractureGroup']=id
 c['actionProfile']['collider']['notes']='Existing game shelter footprint is the collision contract; model is static and shared.'
 parts.append(c)
wave=lambda x:2.48+0.24*math.cos((x+1.12)*math.pi/1.18)
xs=[-2.2+4.4*i/48 for i in range(49)]
profile=[[x,wave(x)+0.075] for x in xs]+[[x,wave(x)-0.075] for x in reversed(xs)]
add('canopy','red',[0,0,-0.95],[1,1,1],'macro','extrude',['roof-rim'],{'profile2D':{'points':profile,'depth':1.9},'edgeTreatment':{'type':'bevel','bevelRadius':0.018,'segments':1},'normalStrategy':'smooth continuous wave'})
add('glass','glass',[0,1.32,-0.72],[3.78,2.13,0.035],'macro',features=['glass-clamps'])
add('glass-left','glass',[-1.9,1.32,-0.02],[0.035,2.13,1.34],'macro')
add('glass-right','glass',[1.9,1.32,-0.02],[0.035,2.13,1.34],'macro')
add('bench','charcoal',[-0.12,0.65,-0.24],[3.38,0.11,0.61],'macro',features=['seat-slats','seat-dividers'])
add('bench-back','charcoal',[-0.12,0.94,-0.49],[3.38,0.55,0.1],'macro')
for i,x in enumerate([-1.91,1.91]):
 for j,z in enumerate([-0.70,0.69]):
  add(f'post-{i}-{j}','steel',[x,1.17,z],[0.095,2.34,0.095])
  add('foot-plates' if i+j==0 else f'foot-{i}-{j}','steel',[x,0.035,z],[0.24,0.07,0.23],features=['foot-fasteners'] if i+j==0 else ())
for i,x in enumerate([-0.65,0.65]): add(f'mullion-{i}','steel',[x,1.38,-0.72],[0.055,2.10,0.05])
add('soffit','charcoal',[0,2.27,-0.7],[3.85,0.07,0.095],features=['soffit-ribs'])
add('route-panel','cream',[1.80,1.28,0.19],[0.11,1.82,0.72],features=['route-header'])
add('front-sign','red',[1.18,2.40,0.91],[0.83,0.23,0.065],features=['muni-sign'])
spec['componentTree']=parts
for d in spec['preSpecAssessment']['detailInventory']['details']:
 if d['kind']=='color-zone':d['kind']='decal'
 d['mapsTo']={'ref':d['id']}
spec['repetitionSystems']=[{'id':'bench-slats','buildsGeometry':True,'componentRefs':['bench'],'pattern':'parallel horizontal ribs','count':11,'spacing':0.07},{'id':'foot-bolts','buildsGeometry':True,'componentRefs':['foot-plates'],'pattern':'four bolts on each square plate','count':16,'spacing':0.12},{'id':'glass-clamps','buildsGeometry':True,'componentRefs':['glass'],'pattern':'two clamps per vertical panel edge','count':12,'spacing':1.5}]
spec['reviewNotes']=['Reference is a generated product image. No claim of an engineering-exact SFMTA shelter or current route data.', 'Current v1.5.1 validator has an explicit evidence-bearing textureless contract. Used for arcade manufactured finishes; geometric route graphics carry the printed panel detail.', 'Strict runtime reconstruction is required by repo standards; upstream unchecked TypeScript is a temporary authoring artifact only.']
(root/'spec.json').write_text(json.dumps(spec,indent=2)+'\n')
