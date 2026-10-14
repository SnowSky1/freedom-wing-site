import * as THREE from "./lib/three.module.js";
import {sampleParticle,createSample,eulerMatrix,apply3} from "./gallery-particle-math.js";
export const DECORATE_ADJUST=new THREE.Matrix4().makeRotationY(-Math.PI/2).premultiply(new THREE.Matrix4().makeRotationX(Math.PI/2));

const vertex=`
attribute vec4 aMultiplier; attribute vec4 aOffset;
varying vec2 vUv; varying vec4 vMultiplier; varying vec4 vOffset;
void main(){vUv=uv;vMultiplier=aMultiplier;vOffset=aOffset;
gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const fragment=`
uniform sampler2D uMap;uniform float uAlphaThreshold;
varying vec2 vUv;varying vec4 vMultiplier;varying vec4 vOffset;
void main(){vec4 texel=texture2D(uMap,vUv);
vec4 result=texel*vMultiplier+vOffset;
if(result.a<uAlphaThreshold || result.a<=0.0)discard;
gl_FragColor=result;}`;
const graphs=new Map(),shapes=new Map(),textures=new Map();
export function releaseParticleTextures(){for(const entry of textures.values())entry.then(texture=>texture.dispose());}
async function jsonAsset(url,cache) {
  if(!cache.has(url))cache.set(url,fetch(url).then(async response=>{
    if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  }));
  return cache.get(url);
}

function cylinder(shape) {
  const positions=[],uvs=[],indices=[],n=shape.segments;
  for(let ring=0;ring<=1;ring++)for(let i=0;i<=n;i++){
    const radius=ring?shape.bottom:shape.top,angle=i*Math.PI*2/n;
    positions.push(Math.cos(angle)*radius,shape.height*(.5-ring),Math.sin(angle)*radius);
    uvs.push(i/n,ring);
  }
  for(let i=0;i<n;i++){const a=i,b=i+n+1;indices.push(a,b,b+1,a,b+1,a+1);}
  for(const [ring,closed,radius] of [[0,shape.topClosed,shape.top],[1,shape.bottomClosed,shape.bottom]]){
    if(!closed || !radius)continue;
    const center=positions.length/3;positions.push(0,shape.height*(.5-ring),0);uvs.push(.5,.5);
    for(let i=0;i<=n;i++){const angle=i*Math.PI*2/n;positions.push(Math.cos(angle)*radius,shape.height*(.5-ring),Math.sin(angle)*radius);uvs.push(.5-.5*Math.cos(angle),.5+.5*Math.sin(angle));}
    for(let i=0;i<n;i++)indices.push(center,center+1+i+(ring?1:0),center+1+i+(ring?0:1));
  }
  return {positions,uvs,indices};
}

export class ParticleEffect {
  static async load(url) {
    const absolute=new URL(url,location.href).href;
    const graph=await jsonAsset(absolute,graphs),rootUrl=new URL(".",absolute);
    const effect=new ParticleEffect(graph);
    const loader=new THREE.TextureLoader();
    for(const emitter of graph.emitters){
      const key=[new URL(emitter.texture,rootUrl).href,emitter.repeat,emitter.smooth,emitter.mipmap].join(":");
      if(!textures.has(key))textures.set(key,(async()=>{
        const texture=await loader.loadAsync(new URL(emitter.texture,rootUrl).href);
        texture.colorSpace=THREE.NoColorSpace;texture.flipY=false;
        texture.wrapS=texture.wrapT=emitter.repeat?THREE.RepeatWrapping:THREE.ClampToEdgeWrapping;
        texture.magFilter=emitter.smooth?THREE.LinearFilter:THREE.NearestFilter;
        texture.generateMipmaps=emitter.mipmap!==false;
        texture.minFilter=texture.generateMipmaps?(emitter.smooth?THREE.LinearMipmapLinearFilter:THREE.NearestMipmapNearestFilter)
          :(emitter.smooth?THREE.LinearFilter:THREE.NearestFilter);
        return texture;
      })());
      let shape;
      if(emitter.shape.kind==="plane") {
        const {w,h}=emitter.shape;
        shape={positions:[-w/2,-h/2,0,w/2,-h/2,0,w/2,h/2,0,-w/2,h/2,0],uvs:[0,1,1,1,1,0,0,0],indices:[0,1,2,0,2,3]};
      } else if(emitter.shape.kind==="cylinder")shape=cylinder(emitter.shape);
      else shape=await jsonAsset(new URL(emitter.shape.file,rootUrl).href,shapes);
      effect.buildEmitter(emitter,shape,await textures.get(key));
    }
    return effect;
  }
  constructor(graph){
    this.graph=graph;this.root=new THREE.Group();this.entries=[];this.elapsed=0;
    this.sample=createSample();this.matrix=new THREE.Matrix4();
    this.inverse=new THREE.Matrix4();this.cameraQuat=new THREE.Quaternion();this.groupQuat=new THREE.Quaternion();
    this.billboardQuat=new THREE.Quaternion();this.temp=new THREE.Vector3();this.scale=new THREE.Vector3();
  }
  buildEmitter(emitter,shape,texture){
    const group=new THREE.Group(),t=emitter.transform;
    group.position.fromArray(t.position);group.rotation.set(...t.rotation.map(x=>x*Math.PI/180),"ZYX");
    group.scale.fromArray(t.scale);this.root.add(group);
    const count=emitter.count,vertices=shape.positions.length/3;
    const positions=new Float32Array(count*vertices*3),uvs=new Float32Array(count*vertices*2);
    const multiplier=new Float32Array(count*vertices*4),offset=new Float32Array(count*vertices*4);
    const indices=[],baked=[];
    for(let i=0;i<count;i++){
      const transformed=[];
      for(let v=0;v<vertices;v++){
        let point=shape.positions.slice(v*3,v*3+3);
        for(const transform of emitter.particles[i].geometryTransforms){
          if(transform.type===0)point=point.map((x,k)=>x+transform.value[k]);
          else if(transform.type===2)point=point.map((x,k)=>x*transform.value[k]);
          else point=apply3(eulerMatrix(transform.value),point);
        }
        transformed.push(...point);
      }
      baked.push(new Float32Array(transformed));
      indices.push(...shape.indices.map(index=>index+i*vertices));
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute("position",new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("uv",new THREE.BufferAttribute(uvs,2).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aMultiplier",new THREE.BufferAttribute(multiplier,4).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aOffset",new THREE.BufferAttribute(offset,4).setUsage(THREE.DynamicDrawUsage));geometry.setIndex(indices);
    const material=new THREE.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,
      uniforms:{uMap:{value:texture},uAlphaThreshold:{value:emitter.alphaThreshold}},
      transparent:true,depthTest:true,depthWrite:false,forceSinglePass:true,toneMapped:false,
      side:emitter.bothSides?THREE.DoubleSide:THREE.FrontSide,
      blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,
      blendSrc:emitter.blend==="normal"&&!emitter.alphaBlending?THREE.OneFactor:THREE.SrcAlphaFactor,
      blendDst:emitter.blend==="add"?THREE.OneFactor:emitter.alphaBlending?THREE.OneMinusSrcAlphaFactor:THREE.ZeroFactor});
    const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;group.add(mesh);
    this.entries.push({emitter,group,geometry,material,mesh,baked,vertices,positions,uvs,multiplier,offset,baseUvs:shape.uvs,active:[]});
  }
  follow(bone,parent){
    parent.updateWorldMatrix(true,false);bone.updateWorldMatrix(true,false);
    this.root.matrixAutoUpdate=false;
    this.root.matrix.copy(parent.matrixWorld).invert().multiply(bone.matrixWorld).multiply(DECORATE_ADJUST);
    this.root.matrixWorldNeedsUpdate=true;
  }
  update(elapsed,camera){
    this.elapsed=elapsed;this.root.updateWorldMatrix(true,true);camera.updateWorldMatrix(true,false);
    camera.getWorldQuaternion(this.cameraQuat);
    for(const entry of this.entries){
      const {emitter,group,vertices}=entry;
      group.matrixWorld.decompose(this.temp,this.groupQuat,this.scale);
      this.billboardQuat.copy(this.groupQuat).invert().multiply(this.cameraQuat);
      const inverseBillboard=this.billboardQuat.clone().invert();
      for(let i=0;i<emitter.count;i++){
        const sample=sampleParticle(emitter,emitter.particles[i],elapsed,this.sample);
        entry.active[i]=sample.active;
        const linear=sample.linear;
        this.matrix.set(linear[0],linear[1],linear[2],0,linear[3],linear[4],linear[5],0,linear[6],linear[7],linear[8],0,0,0,0,1);
        if(sample.toHeading){
          this.temp.fromArray(sample.heading);
          if(sample.billboard){
            this.temp.applyQuaternion(inverseBillboard);
            this.matrix.premultiply(new THREE.Matrix4().makeRotationZ(Math.atan2(this.temp.y,this.temp.x)));
          }else if(this.temp.lengthSq()>1e-12){
            const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1,0,0),this.temp.normalize());
            this.matrix.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
          }
        }
        if(sample.billboard)this.matrix.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(this.billboardQuat));
        const m=this.matrix.elements,baked=entry.baked[i],p=sample.position;
        for(let v=0;v<vertices;v++){
          const dest=(i*vertices+v)*3,source=v*3,x=baked[source],y=baked[source+1],z=baked[source+2];
          entry.positions[dest]=p[0]+m[0]*x+m[4]*y+m[8]*z;
          entry.positions[dest+1]=p[1]+m[1]*x+m[5]*y+m[9]*z;
          entry.positions[dest+2]=p[2]+m[2]*x+m[6]*y+m[10]*z;
          const uvDest=(i*vertices+v)*2,uvSource=v*2,sheet=sample.sheet;
          entry.uvs[uvDest]=sheet?(entry.baseUvs[uvSource]+sheet.frame%sheet.columns)/sheet.columns:entry.baseUvs[uvSource];
          entry.uvs[uvDest+1]=sheet?(entry.baseUvs[uvSource+1]+Math.floor(sheet.frame/sheet.columns))/sheet.rows:entry.baseUvs[uvSource+1];
          for(let axis=0;axis<2;axis++)entry.uvs[uvDest+axis]=entry.uvs[uvDest+axis]*sample.uvScale[axis]+sample.uvOffset[axis];
          const colorDest=(i*vertices+v)*4;
          for(let k=0;k<4;k++){entry.multiplier[colorDest+k]=sample.multiplier[k];entry.offset[colorDest+k]=sample.offset[k];}
          if(!sample.active){entry.multiplier[colorDest+3]=0;entry.offset[colorDest+3]=0;}
        }
      }
      for(const name of ["position","uv","aMultiplier","aOffset"])entry.geometry.attributes[name].needsUpdate=true;
    }
  }
  diagnostics(){return {source:this.graph.source,emitters:this.entries.length,particles:this.graph.particleCount,time:this.elapsed,
    active:this.entries.reduce((sum,e)=>sum+e.active.filter(Boolean).length,0),
    signature:this.entries.reduce((sum,e)=>sum+e.positions.reduce((s,v,i)=>s+v*((i%7)+1),0)+e.multiplier.reduce((s,v)=>s+v,0),0),
    finite:this.entries.every(e=>e.positions.every(Number.isFinite)&&e.multiplier.every(Number.isFinite)&&e.offset.every(Number.isFinite))};}
  worldBounds(){
    this.root.updateWorldMatrix(true,true);
    const box=new THREE.Box3(),point=new THREE.Vector3();
    for(const entry of this.entries)for(let i=0;i<entry.emitter.count;i++){
      if(!entry.active[i])continue;
      for(let v=0;v<entry.vertices;v++){
        point.fromArray(entry.positions,(i*entry.vertices+v)*3).applyMatrix4(entry.group.matrixWorld);
        box.expandByPoint(point);
      }
    }
    return box;
  }
  dispose(){this.root.removeFromParent();for(const entry of this.entries){entry.geometry.dispose();entry.material.dispose();} }
}
