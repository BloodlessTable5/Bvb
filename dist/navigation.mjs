export const MOVEMENT_KEYS=['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'];
export class MovementControls {
  constructor(){this.reset();}
  reset(){this.mode='mouse';this.keys={};this.direction={x:1,y:0};}
  press(code){this.keys[code]=true;if(MOVEMENT_KEYS.includes(code))this.mode='keyboard';}
  release(code){delete this.keys[code];}
  clear(){this.keys={};}
  usePointer(){this.mode='mouse';this.clear();}
  target(pointer,camera,center,width,height){
    if(this.mode==='mouse'){
      const target=steeringTarget(pointer,camera,center,width,height),dx=target.x-center.x,dy=target.y-center.y,length=Math.hypot(dx,dy);
      if(length>1)this.direction={x:dx/length,y:dy/length};
      return target;
    }
    const dx=Number(!!(this.keys.KeyD||this.keys.ArrowRight))-Number(!!(this.keys.KeyA||this.keys.ArrowLeft));
    const dy=Number(!!(this.keys.KeyS||this.keys.ArrowDown))-Number(!!(this.keys.KeyW||this.keys.ArrowUp));
    if(!dx&&!dy)return {...center};
    const length=Math.hypot(dx,dy);this.direction={x:dx/length,y:dy/length};
    return {x:center.x+this.direction.x*450,y:center.y+this.direction.y*450};
  }
  actionTarget(pointer,camera,center,width,height){
    const target=this.target(pointer,camera,center,width,height);
    return this.mode==='keyboard'||Math.hypot(target.x-center.x,target.y-center.y)<1?{x:center.x+this.direction.x*450,y:center.y+this.direction.y*450}:target;
  }
}
// Screen-space input is reprojected every frame, so an edge pointer keeps moving.
export function steeringTarget(pointer,camera,center,width,height) {
  if(!pointer.active)return {...center};
  const x=Math.max(0,Math.min(width,pointer.x)),y=Math.max(0,Math.min(height,pointer.y));
  const dx=x-width/2,dy=y-height/2;
  if(x<=20||x>=width-20||y<=20||y>=height-20){
    const length=Math.hypot(dx,dy)||1;
    return {x:center.x+dx/length*10000,y:center.y+dy/length*10000};
  }
  return {x:camera.x+dx/camera.zoom,y:camera.y+dy/camera.zoom};
}

export function edgeIndicator(position,camera,width,height,inset=13) {
  const dx=(position.x-camera.x)*camera.zoom,dy=(position.y-camera.y)*camera.zoom;
  const r=(position.radius||0)*camera.zoom;
  if(Math.abs(dx)<=width/2+r&&Math.abs(dy)<=height/2+r)return null;
  const scale=Math.min((width/2-inset)/Math.abs(dx),(height/2-inset)/Math.abs(dy));
  return {x:width/2+dx*scale,y:height/2+dy*scale,angle:Math.atan2(dy,dx)};
}
