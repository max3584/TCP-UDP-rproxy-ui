import { DefaultSession, ISODateString } from 'next-auth';
import pino from 'pino';


export const Logger = (level : string, {...propaty}: any) => {
  return pino({
    level: level
  }).child(propaty);
}

export interface ForwardRule {
  protocol: string;
  srcAddr: string;
  srcPort: number;
  distAddr: string;
  distPort: number;
}

export interface ForwardRules extends ForwardRule {
  id: number;
}

export interface PageAuthrized {
  isAuthorized: boolean;
}

export interface sessionUser extends DefaultSession {
  user: {
    name: string;
    email: string;
    image: string;
    id: string;
    role: string;
  }
  expires: ISODateString;
}