const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function pointSegment(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1),0,1);return distance(p,{x:a.x+t*dx,y:a.y+t*dy});}
function cross(a,b,c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
function inside(p,polygon){let result=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)result=!result;}return result;}
function segmentDistance(a,b,c,d){
  const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
  if(abC*abD<0&&cdA*cdB<0)return 0;
  return Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));
}
export class ArenaNavigator {
  constructor(obstacles,world){this.obstacles=obstacles;this.world=world;this.graphs=new Map();}
  clear(a,b,r){
    if(b.x<r||b.y<r||b.x>this.world.width-r||b.y>this.world.height-r)return false;
    for(const {points:p} of this.obstacles){
      if(inside(a,p)||inside(b,p))return false;
      for(let i=0;i<p.length;i++)if(segmentDistance(a,b,p[i],p[(i+1)%p.length])<r-.05)return false;
    }
    return true;
  }
  graph(r){
    const clearance=Math.ceil(r/8)*8;
    if(this.graphs.has(clearance))return this.graphs.get(clearance);
    const nodes=[];
    for(const {points} of this.obstacles){
      const left=Math.min(...points.map(p=>p.x))-clearance-12,right=Math.max(...points.map(p=>p.x))+clearance+12,top=Math.min(...points.map(p=>p.y))-clearance-12,bottom=Math.max(...points.map(p=>p.y))+clearance+12;
      for(const x of [left,right])for(const y of [top,bottom])if(this.clear({x,y},{x,y},clearance))nodes.push({x,y});
    }
    const edges=nodes.map(()=>[]);
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)if(this.clear(nodes[i],nodes[j],clearance)){const cost=distance(nodes[i],nodes[j]);edges[i].push({to:j,cost});edges[j].push({to:i,cost});}
    const graph={nodes,edges};this.graphs.set(clearance,graph);return graph;
  }
  route(start,goal,r){
    if(this.clear(start,goal,r))return [goal];
    const graph=this.graph(r),nodes=[...graph.nodes,start,goal],n=nodes.length,source=n-2,destination=n-1;
    const edges=graph.edges.map(e=>[...e]);edges.push([],[]);
    for(let i=0;i<n-2;i++)for(const endpoint of [source,destination])if(this.clear(nodes[endpoint],nodes[i],r)){const cost=distance(nodes[endpoint],nodes[i]);edges[endpoint].push({to:i,cost});edges[i].push({to:endpoint,cost});}
    const costs=Array(n).fill(Infinity),previous=Array(n).fill(-1),visited=new Set();costs[source]=0;
    for(let step=0;step<n;step++){
      let current=-1;for(let i=0;i<n;i++)if(!visited.has(i)&&(current<0||costs[i]<costs[current]))current=i;
      if(current===destination||!Number.isFinite(costs[current]))break;visited.add(current);
      for(const edge of edges[current])if(costs[current]+edge.cost<costs[edge.to]){costs[edge.to]=costs[current]+edge.cost;previous[edge.to]=current;}
    }
    if(!Number.isFinite(costs[destination]))return [];
    const route=[];for(let at=destination;at!==source;at=previous[at])route.unshift(nodes[at]);return route;
  }
  waypoint(cell,goal,r,time){
    if(this.clear(cell,goal,r)){cell.route=null;return goal;}
    if(!cell.route||time>=cell.routeUntil||distance(goal,cell.routeGoal)>100){cell.route=this.route(cell,goal,r);cell.routeUntil=time+1.2;cell.routeGoal={...goal};}
    while(cell.route.length&&distance(cell,cell.route[0])<12)cell.route.shift();
    return cell.route[0]||cell;
  }
}
