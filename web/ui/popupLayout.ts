export interface PopupAnchor {left:number;right:number;top:number;bottom:number}
export interface PopupViewport {left:number;top:number;width:number;height:number}
/** Keep the complete popup visible, preferring below when both sides fit. */
export function popupLayout(anchor:PopupAnchor,viewport:PopupViewport,options:{width:number;height:number;maxHeight?:number;gap?:number;padding?:number;side?:'auto'|'top'|'bottom'}){
 const padding=options.padding??8,gap=options.gap??4;
 const left=viewport.left+padding,top=viewport.top+padding;
 const right=Math.max(left,viewport.left+viewport.width-padding),bottom=Math.max(top,viewport.top+viewport.height-padding);
 const width=Math.max(0,Math.min(options.width,right-left));
 const desired=Math.max(0,Math.min(options.height,options.maxHeight??420,bottom-top));
 const above=Math.max(0,anchor.top-top-gap),below=Math.max(0,bottom-anchor.bottom-gap);
 const useTop=options.side==='bottom'?below<desired&&above>below:options.side==='top'?above>=desired||above>=below:below<desired&&above>below;
 const available=useTop?above:below;
 const height=Math.min(desired,available<Math.min(desired,64)?bottom-top:available);
 return {left:Math.max(left,Math.min(anchor.left,right-width)),top:Math.max(top,Math.min(useTop?anchor.top-gap-height:anchor.bottom+gap,bottom-height)),width,maxHeight:height,side:useTop?'top':'bottom'};
}
