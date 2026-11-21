import type {WorkMode} from '../modes';
export interface SidebarProject {id:string;name:string;archivedAt:string|null;pinnedAt:string|null;position:number;approvalMode?:import('../../contracts/permissions').ApprovalMode;folderName:string|null}
export interface SidebarTask {id:string;runId:string;projectId:string;title:string;mode?:WorkMode;status:string;createdAt:string;updatedAt:string;pinnedAt:string|null;archivedAt:string|null;unreadAt:string|null;groupId:string|null;awaitingAnswer?:boolean|number}
export interface SidebarGroup {id:string;name:string}
export interface SidebarTree {projects:SidebarProject[];tasks:SidebarTask[];groups:SidebarGroup[]}
