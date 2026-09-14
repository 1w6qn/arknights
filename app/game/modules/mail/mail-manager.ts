import { MailItem, MailMetaInfo } from "./mail.model";
import { ItemBundle } from "@excel/excel";
import { now } from "@utils/time";
import { writeFile } from "fs/promises";
import { readFileSync } from "fs";

export class MailManager {
  database: MailDB;

  constructor() {
    this.database = JSON.parse(
      readFileSync(`${__dirname}/../../../../data/user/mails.json`, "utf8"),
    );
  }

  /**
   * 归一化邮件列表过滤参数（缺省为空数组）
   *
   * 修复：客户端可能省略部分字段（尤其初始化时传空对象），若直接使用
   * args.sysMailIdList.includes 会对 undefined 抛错导致 500。统一默认空数组。
   * @param args - 请求中的过滤参数（可缺省）
   * @returns 归一化后的过滤参数
   */
  private normalizeListArgs(args?: {
    sysMailIdList?: number[];
    surveyMailIdList?: string[];
    mailIdList?: number[];
  }): { sysMailIdList: number[]; surveyMailIdList: string[]; mailIdList: number[] } {
    return {
      sysMailIdList: args?.sysMailIdList ?? [],
      surveyMailIdList: args?.surveyMailIdList ?? [],
      mailIdList: args?.mailIdList ?? [],
    };
  }

  async listMailbox(
    uid: string,
    args: {
      sysMailIdList: number[];
      surveyMailIdList: string[];
      mailIdList: number[];
    },
  ): Promise<MailItem[]> {
    const { sysMailIdList, surveyMailIdList, mailIdList } =
      this.normalizeListArgs(args);
    return (this.database.user[uid] ?? []).filter((mail) => {
      return (
        sysMailIdList.includes(mail.mailId) ||
        surveyMailIdList.includes(mail.mailId.toString()) ||
        mailIdList.includes(mail.mailId)
      );
    });
  }

  async receiveMail(
    uid: string,
    args: { mailId: number; type: number },
  ): Promise<ItemBundle[]> {
    const mail = (this.database.user[uid] ?? []).find(
      (mail) => mail.mailId === args.mailId && mail.type === args.type,
    );
    let items: ItemBundle[] = [];
    if (mail && mail.receiveAt == -1) {
      mail.receiveAt = now();
      if (mail.hasItem) {
        items = mail.items;
      }
    }
    await this.saveDatabase();
    return items;
  }

  /** 管理用：列出某用户全部邮件（不做任何过滤） */
  listAllMail(uid: string): MailItem[] {
    return this.database.user[uid] ?? [];
  }

  /** 管理用：删除某用户单封邮件，返回是否删除成功 */
  async deleteMail(uid: string, mailId: number): Promise<boolean> {
    const list = this.database.user[uid] ?? [];
    const idx = list.findIndex((mail) => mail.mailId === mailId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    await this.saveDatabase();
    return true;
  }

  async getMetaInfoList(
    uid: string,
    args: { from: number },
  ): Promise<MailMetaInfo[]> {
    return (this.database.user[uid] ?? []).map((mail) => {
      return {
        mailId: mail.mailId,
        createAt: mail.createAt,
        state: mail.state,
        hasItem: mail.hasItem,
        type: mail.type,
      } as MailMetaInfo;
    });
  }

  async receiveAllMail(
    uid: string,
    args: {
      sysMailIdList: number[];
      surveyMailIdList: string[];
      mailIdList: number[];
    },
  ): Promise<ItemBundle[]> {
    const { sysMailIdList, surveyMailIdList, mailIdList } =
      this.normalizeListArgs(args);
    const mailList = (this.database.user[uid] ?? []).filter((mail) => {
      return (
        sysMailIdList.includes(mail.mailId) ||
        surveyMailIdList.includes(mail.mailId.toString()) ||
        mailIdList.includes(mail.mailId)
      );
    });
    const items: ItemBundle[] = [];
    mailList.forEach((mail) => {
      if (mail && mail.receiveAt == -1) {
        mail.receiveAt = now();
        if (mail.hasItem) {
          items.push(...mail.items);
        }
      }
    });
    await this.saveDatabase();
    return items;
  }

  async removeAllReceivedMail(
    uid: string,
    args: {
      sysMailIdList: number[];
      surveyMailIdList: string[];
      mailIdList: number[];
    },
  ) {
    const { sysMailIdList, surveyMailIdList, mailIdList } =
      this.normalizeListArgs(args);
    this.database.user[uid] = (this.database.user[uid] ?? []).filter((mail) => {
      return !(
        sysMailIdList.includes(mail.mailId) ||
        surveyMailIdList.includes(mail.mailId.toString()) ||
        mailIdList.includes(mail.mailId)
      );
    });
    await this.saveDatabase();
  }

  /**
   * 发送系统邮件
   * @param uid - 接收者用户ID
   * @param args - 邮件内容参数（标题、正文、附件）
   * @returns 创建的邮件对象
   */
  async sendMail(uid: string, args: SendMailArgs): Promise<MailItem> {
    const userMails = (this.database.user[uid] ??= []);
    const mail = buildMailItem(uid, args, nextMailId(this.database));
    userMails.push(mail);
    await this.saveDatabase();
    return mail;
  }

  async saveDatabase() {
    await writeFile(
      `${__dirname}/../../../../data/user/mails.json`,
      JSON.stringify(this.database),
    );
  }
}
export interface MailDB {
  user: { [key: string]: MailItem[] };
}

/** 邮件创建参数 */
export interface SendMailArgs {
  subject: string;
  content: string;
  items: ItemBundle[];
  /** 过期时间戳；缺省 30 天后 */
  expireAt?: number;
}

/** 生成全局唯一邮件ID（扫描现有最大值+1，最小 1000000） */
export function nextMailId(database: MailDB): number {
  let max = 0;
  for (const uid of Object.keys(database.user)) {
    for (const mail of database.user[uid]) {
      if (mail.mailId > max) max = mail.mailId;
    }
  }
  return Math.max(max + 1, 1000000);
}

/**
 * 构造邮件对象（纯函数，便于单测）
 * @param uid - 接收者用户ID
 * @param args - 邮件内容参数
 * @param mailId - 邮件ID（调用方保证全局唯一，通常由 nextMailId 生成）
 */
export function buildMailItem(
  uid: string,
  args: SendMailArgs,
  mailId: number,
): MailItem {
  return {
    uid,
    mailId,
    from: "system",
    subject: args.subject,
    content: args.content,
    createAt: now(),
    expireAt: args.expireAt ?? now() + 30 * 24 * 3600,
    receiveAt: -1,
    state: 0,
    style: { route: 0, banner: "" },
    platform: -1,
    type: 0,
    hasItem: args.items.length > 0 ? 1 : 0,
    items: args.items,
  };
}

export const mailManager = new MailManager();
