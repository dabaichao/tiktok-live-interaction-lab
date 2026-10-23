import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { DouyinWebcastProxy } from "../src/douyin/DouyinWebcastProxy.js";

it("reports a browser disconnect immediately and ignores close events from a former connection", async () => {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(upstream,"listening");
  const address=upstream.address(); if(typeof address==="string")throw new Error("missing port");
  const proxy=new DouyinWebcastProxy(undefined,{createTarget:()=>new WebSocket(`ws://127.0.0.1:${address.port}`)});
  const states:string[]=[];proxy.onTransportState(value=>states.push(value.state));
  const server=createServer();proxy.attach(server);server.listen(0,"127.0.0.1");await once(server,"listening");
  const port=server.address();if(!port||typeof port==="string")throw new Error("missing port");
  const connect=async()=>{
    const socket=new WebSocket(`ws://127.0.0.1:${port.port}/socket/webcast/im/push/v2/`);
    await once(socket,"open");
    for(let n=0;n<100&&proxy.diagnostics().transport.state!=="connected";n++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(proxy.diagnostics().transport.state).toBe("connected");return socket;
  };
  let first:WebSocket|undefined,second:WebSocket|undefined;
  try {
    first=await connect();second=await connect();
    first.close();await once(first,"close");await new Promise(resolve=>setTimeout(resolve,20));
    expect(proxy.diagnostics().transport.state).toBe("connected");
    second.terminate();await once(second,"close");
    for(let n=0;n<100&&proxy.diagnostics().transport.state!=="disconnected";n++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(proxy.diagnostics().transport.state).toBe("disconnected");
    expect(states.at(-1)).toBe("disconnected");
  } finally {
    first?.terminate();second?.terminate();proxy.close();
    for(const socket of upstream.clients)socket.terminate();
    await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>upstream.close(()=>resolve()))]);
  }
});
