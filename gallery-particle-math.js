export const TAU = Math.PI * 2;
export const mod = (value, period) => value - Math.floor(value / period) * period;
export function segments(start, end, points, life, out) {
  let previous = start, previousLife = 0;
  for (const [nextLife, next] of [...points, [1, end]]) {
    if (life < nextLife || (life === nextLife && nextLife > previousLife)) {
      const fraction = nextLife > previousLife ? (life-previousLife)/(nextLife-previousLife) : 1;
      for (let k=0;k<out.length;k++) out[k]=previous[k]+(next[k]-previous[k])*fraction;
      return out;
    }
    previous = next; previousLife = nextLife;
  }
  for (let k=0;k<out.length;k++) out[k]=end[k];
  return out;
}
export function particleClock(emitter, particle, elapsed) {
  // ParticleAnimator.resetTime offsets the state's start time. A negative
  // instance offset prewarms the effect (not a long delay before emission).
  const duration=Math.max(.00001,particle.duration), age=elapsed*emitter.playSpeed-emitter.timeOffset-particle.start;
  let seconds=age, active=age>=0;
  if (emitter.time.usesDuration) {
    if (emitter.time.usesLooping) {
      seconds=mod(age,duration+(emitter.time.usesDelay?particle.delay:0));
      if (emitter.time.usesDelay) active &&= seconds<duration;
    } else active &&= age<=duration;
  }
  return {seconds,life:seconds/duration,active};
}
export function rotationMatrix(axis, angle) {
  let [x,y,z]=axis, length=Math.hypot(x,y,z);
  if (!length) {x=0;y=0;z=1;length=1;}
  x/=length;y/=length;z/=length;
  const c=Math.cos(angle),s=Math.sin(angle),t=1-c;
  return [t*x*x+c,t*x*y-s*z,t*x*z+s*y,t*x*y+s*z,t*y*y+c,t*y*z-s*x,t*x*z-s*y,t*y*z+s*x,t*z*z+c];
}
export function multiply3(a,b,out=[]) {
  const values=[];
  for(let row=0;row<3;row++) for(let column=0;column<3;column++)
    values[row*3+column]=a[row*3]*b[column]+a[row*3+1]*b[3+column]+a[row*3+2]*b[6+column];
  for(let i=0;i<9;i++)out[i]=values[i];
  return out;
}
export function eulerMatrix(degrees) {
  const [x,y,z]=degrees.map(value=>value*Math.PI/180);
  return multiply3(rotationMatrix([0,0,1],z),multiply3(rotationMatrix([0,1,0],y),rotationMatrix([1,0,0],x)));
}
export function apply3(matrix, point, out=[]) {
  for(let k=0;k<3;k++)out[k]=matrix[k*3]*point[0]+matrix[k*3+1]*point[1]+matrix[k*3+2]*point[2];
  return out;
}
export function sampleParticle(emitter, particle, elapsed, out) {
  const {seconds,life,active}=particleClock(emitter,particle,elapsed);
  out.position.fill(0);out.heading.fill(0);out.multiplier.fill(1);out.offset.fill(0);
  out.linear.splice(0,9,1,0,0,0,1,0,0,0,1);out.sheet=null;out.billboard=false;out.toHeading=false;
  out.uvScale=[1,1];out.uvOffset=[0,0];
  const colorScratch=new Array(8), scaleScratch=new Array(3);
  for(const node of particle.nodes) {
    switch(node.type) {
      case "Position":
        for(let k=0;k<3;k++)out.position[k]+=node.value[k];
        break;
      case "Velocity":
        for(let k=0;k<3;k++){out.position[k]+=node.value[k]*seconds;out.heading[k]+=node.value[k];}
        break;
      case "Acceleration":
        for(let k=0;k<3;k++){out.position[k]+=.5*node.value[k]*seconds*seconds;out.heading[k]+=node.value[k]*seconds;}
        break;
      case "BezierCurve":
        for(let k=0;k<3;k++){
          out.position[k]+=2*life*(1-life)*node.control[k]+life*life*node.end[k];
          out.heading[k]+=2*(1-2*life)*node.control[k]+2*life*node.end[k];
        }
        break;
      case "Orbit": {
        const [radius,cycle,phase]=node.value, angular=TAU/(node.usesCycle?Math.max(.00001,cycle):1);
        const angle=(node.usesCycle?seconds:life)*angular+(node.usesPhase?phase*Math.PI/180:0);
        const orbit=[Math.cos(angle)*radius,Math.sin(angle)*radius,0];
        // This is the shipped velocity register convention, rather than a physical derivative.
        const magnitude=radius*(node.usesCycle?cycle:1/Math.max(life,.00001));
        const velocity=[-Math.sin(angle)*magnitude,Math.cos(angle)*magnitude,0];
        const rotation=eulerMatrix(node.eulers);
        const p=apply3(rotation,orbit),v=apply3(rotation,velocity);
        for(let k=0;k<3;k++){out.position[k]+=p[k];out.heading[k]+=v[k];}
        break;
      }
      case "RotationalVelocity":
        multiply3(rotationMatrix(node.axis,TAU*seconds/Math.max(.00001,node.cycle)),out.linear,out.linear);
        break;
      case "Scale": {
        const [minimum,maximum,cycle,phase]=node.value;
        const s=node.usesCycle ? (minimum+maximum)/2+Math.abs(maximum-minimum)/2*
          Math.sin(TAU*seconds/Math.max(.00001,cycle)+(node.usesPhase?phase*Math.PI/180:0))
          : minimum+(maximum-minimum)*life;
        for(let k=0;k<9;k++)out.linear[k]*=s;
        break;
      }
      case "SegmentedScale":
        segments(node.start,node.end,node.points,life,scaleScratch);
        for(let row=0;row<3;row++)for(let column=0;column<3;column++)out.linear[row*3+column]*=scaleScratch[row];
        break;
      case "InitialColor":
      case "SegmentedColor":
      case "Color": {
        if(node.type==="InitialColor") for(let k=0;k<8;k++)colorScratch[k]=node.value[k];
        else {
          const fraction=node.type==="Color" && node.usesCycle ?
            Math.sin(TAU*seconds/Math.max(.00001,node.cycle)+(node.usesPhase?node.phase*Math.PI/180:0)) : life;
          segments(node.start,node.end,node.points,fraction,colorScratch);
        }
        if(node.multiplier)for(let k=0;k<4;k++)out.multiplier[k]*=colorScratch[k];
        if(node.offset)for(let k=0;k<4;k++)out.offset[k]+=colorScratch[k+4];
        break;
      }
      case "SpriteSheet": {
        const [cycle,phase]=node.value;
        const progress=node.usesCycle ? mod(seconds+(node.usesPhase?phase:0),Math.max(.00001,cycle))/Math.max(.00001,cycle) : life;
        // Sheet offset is quantized, but original geometry UVs remain unmodified.
        const frame=Math.min(node.total-1,Math.floor(progress*node.total));
        out.sheet={frame,columns:node.columns,rows:node.rows};
        break;
      }
      case "UV": {
        const axis=node.axis==="x"?0:1,phase=seconds/Math.max(.00001,node.cycle);
        out.uvScale[axis]*=node.scale;
        out.uvOffset[axis]+=node.formula===2?Math.sin(TAU*phase):phase;
        break;
      }
      case "Billboard":out.billboard=true;break;
      case "RotateToHeading":out.toHeading=true;break;
      default:throw new Error(`Unsupported runtime particle node ${node.type}`);
    }
  }
  if(!active)out.linear.fill(0);
  out.active=active;out.life=life;out.seconds=seconds;
  return out;
}
export const createSample=()=>({position:[0,0,0],heading:[0,0,0],linear:[1,0,0,0,1,0,0,0,1],multiplier:[1,1,1,1],offset:[0,0,0,0]});
