import { AvatarInfo, SharedCharData } from './model';
import { PlayerBirthday, PlayerMedalCustomLayout, PlayerNameCardSkin, PlayerNameCardStyle } from './playerdata';
export interface FriendDataWithNameCard extends FriendData {
    registerTs:number,
    mainStageProgress:string|null,
    charCnt:number,
    furnCnt:number,
    skinCnt:number,
    secretary:string,
    secretarySkinId:string,
    resume:string,
    team?:{[key:string]:number},
    teamV2:{[key:string]:number},
    medalBoard:FriendMedalBoard,
    birthday:PlayerBirthday,
    nameCardStyle:PlayerNameCardStyle,
}
export interface FriendData extends FriendCommonData{
    assistCharList:SharedCharData[],
    board:string[],
    infoShare:number,
    infoShareVisited?:number,
    skin:PlayerNameCardSkin
}
export interface FriendCommonData{
    nickName:string,
    uid:string,
    serverName:string,
    nickNumber:string,
    level:number,
    lastOnlineTime:number,
    recentVisited:number,
    avatar:AvatarInfo
}
export interface FriendMedalBoard{
    type:string,
    custom:PlayerMedalCustomLayout|null,
    template:FriendMedalTemplateGroupInfo|null
}
export interface FriendMedalTemplateGroupInfo{
    groupId:string,
    medalList:string[]
}