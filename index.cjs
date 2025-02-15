const { Router, Response, Request, } = require("express");
const jsonParser = require("body-parser").json();
const TelegramBot = require("node-telegram-bot-api");

const router = Router();
const TELEGRAM_HOST = "api.telegram.org";
const FORWARD_TIME = 1000;

/**
 * @param {object} body - telegram native body
 * @returns {object|Error}
 */
function getMessageFromBody(body) {
  let message;
  let type;
  if (body.message) {
    type = "message";
    message = body.message;
  } else if (body.edited_message) {
    type = "edited_message";
    message = body.edited_message;
  } else if (body.channel_post) {
    type = "channel_post";
    message = body.channel_post;
  } else if (body.callback_query) {
    type = "callback_query";
    message = body.callback_query.message;
  } else {
    throw new Error("Unknown Telegram Body");
  }

  const chatId = String(message.chat?.id);
  const userId = String(message.from?.id);
  return {
    type,
    message,
    chatId,
    userId
  }
}

/**
 * @param {*} message
 * @param {*} metadata
 * @param {*} eventsList
 * @returns {string}
 */
function getEventName(message, metadata, eventsList) {
  switch (metadata.type) {
    case "contact": {
      if (!message.from.is_bot && message.contact.user_id === message.from.id) {
        return "auth_by_contact";
      }
      return "contact";
    }
    case "text": {
      // Check RegExp - in first
      for (const str of eventsList) {
        if (str.startsWith("/")) {
          const lastSlash = str.lastIndexOf("/");
          const restoredRegex = new RegExp(str.slice(1, lastSlash), str.slice(lastSlash + 1));

          if (restoredRegex.exec(message.text)) {
            return str;
          }
        }
      }
      if (message.type === "edited_message") {
        return "edited_message_text";
      }
      if (message.reply_to_message) {
        return "reply_to_message";
      }
      // todo стоит добавить возможность отдавать несколько типов событий. например, когда текст будет вида "hello /ping"
      if (Array.isArray(message.entities)) {
        if (message.entities.some((entity) => entity.type === "mention" )) {
          return "mention";
        }
        if (message.entities.some((entity) => entity.type === "bot_command" )) {
          return "bot_command";
        }
      }
      return metadata.type;
    }
    default: {
      return metadata.type;
    }
  }
}

class TelegramBotController {
  /**
   * @constructor
   * @param {Object} args
   * @param {String} args.token - telegram token
   * @param {String} [args.domain]
   * @param {Number} [args.port]
   * @param {Boolean} [args.restart]
   * @param {Object} privateEvents
   * @param {Object} publicEvents
   * @param {Function} [args.onError]
   * @returns {{bot: TelegramBot, middleware: Router}}
   */
  constructor({
                token,
                domain,
                port,
                restart = false,
                privateEvents = {},
                publicEvents = {},
                onError = console.error,
              }) {
    let telegramBot;

    if (String(process.env.NODE_ENV).toLowerCase() === "test") {
      if (!domain) {
        throw new Error("domain not init");
      }
      if (!port) {
        throw new Error("Port not init");
      }
      telegramBot = new TelegramBot(token, {
        polling: true,
        baseApiUrl: `http://${domain}:${port}`
      });
      telegramBot.startPolling({ restart: restart });
      telegramBot.on("polling_error", (error) => {
        console.error(error.stack);
      });
    } else if (domain) {
      telegramBot = new TelegramBot(token);
      telegramBot
        .deleteWebHook()
        .then(() => {
          console.log("Webhook удалён");
        })
        .catch(() => {})
        .finally(() => {
          return telegramBot
            .setWebHook(`${domain}/telegram/bot${token}`, {
              max_connections: 3,
              baseApiUrl: "https://" + TELEGRAM_HOST,
            })
        })
        .then(() => telegramBot.getWebHookInfo())
        .then((webhookInfo) => {
          console.log(webhookInfo);
        })
        .catch((error) => {
          console.error(error.stack);
        });
      telegramBot.on("webhook_error", (error) => {
        console.error(error.stack);
      });
    } else {
      telegramBot = new TelegramBot(token);
      telegramBot.startPolling({ restart: restart });
      telegramBot.on("polling_error", (error) => {
        console.error(error.stack);
      });
    }

    const ownPrivateEvents = Reflect.ownKeys(privateEvents);
    const ownPublicEvents = Reflect.ownKeys(publicEvents);
    const transactionMessages = new Map();

    telegramBot.on("message", async (message, metadata) => {
      if (message.forward_from || message.forward_from_chat) {
        if (message.chat.id === message.from.id) {
          const key = message.chat.id;
          let messages = [];
          if (transactionMessages.has(key)) {
            const transaction = transactionMessages.get(key);
            if (transaction.timeoutId) {
              clearTimeout(transaction.timeoutId);
            }
            messages = transaction.messages;
          }
          messages.push(message);
          const timeoutId = setTimeout(async () => {
            if (transactionMessages.has(key)) {
              const { messages, timeoutId } = transactionMessages.get(key);
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
              try {
                const extMessages = await Promise.all(messages.map((message) => {
                  return this.extendMessage(message);
                }));
                if (privateEvents["message_forwards"]) {
                  await privateEvents["message_forwards"](this.bot, extMessages);
                }
              } catch (error) {
                this.bot.emit("error", error);
              } finally {
                transactionMessages.delete(key);
              }
            }
          }, FORWARD_TIME);
          transactionMessages.set(key, {
            messages,
            timeoutId,
          });
          return;
        }
      }

      message = await this.extendMessage(message);
      if (message.chat.type === "private") {
        const eventName = getEventName(message, metadata, ownPrivateEvents);
        if (privateEvents[eventName]) {
          try {
            await privateEvents[eventName](this.bot, message);
          } catch (error) {
            this.bot.emit("error", error);
          }
        } else {
          console.warn("Unknown private event: " + eventName);
        }
      } else {
        const eventName = getEventName(message, metadata, ownPublicEvents);
        if (publicEvents[eventName]) {
          try {
            await publicEvents[eventName](this.bot, message);
          } catch (error) {
            this.bot.emit("error", error);
          }
        } else {
          console.warn("Unknown public event: " + eventName);
        }
      }
    });
    telegramBot.on("channel_post", async (message) => {
      if (publicEvents["channel_post"]) {
        await publicEvents["channel_post"](this.bot, message);
      }
    });
    telegramBot.on('callback_query', async (query) => {
      if (publicEvents[query.data]) {
        await publicEvents[query.data](this.bot, {
          id: query.id,
          ...query.message,
        });
      }
      if (privateEvents[query.data]) {
        await privateEvents[query.data](this.bot, {
          id: query.id,
          ...query.message,
        });
      }
    });
    telegramBot.on('inline_query', async (message) => {
      if (message.chat_type === 'private' || message.chat_type === 'sender') {
        if (privateEvents['inline_query']) {
          await privateEvents['inline_query'](this.bot, message);
        }
      } else if (message.chat_type === 'group' || message.chat_type === 'supergroup') {
        if (publicEvents['inline_query']) {
          await publicEvents['inline_query'](this.bot, message);
        }
      }
    });
    telegramBot.on("error", (error) => {
      onError(this.bot, error);
    });

    this.bot = telegramBot;
    router.post(`/telegram/bot${token}`, jsonParser, (request, response) => this.api.apply(this, [request, response]));

    return {
      bot: telegramBot,
      middleware: router,
    };
  }
  async extendMessage(message) {
    if (message.voice?.file_id) {
      message.voice.file = await this.getTelegramFile(message.voice.file_id);
    }
    if (message.document?.file_id) {
      message.document.file = await this.getTelegramFile(message.document.file_id);
      const thumb = message.document?.thumb || message.document?.thumbnail;
      if (thumb) {
        message.document.thumb.file = await this.getTelegramFile(thumb.file_id);
      }
    }
    if (message.video?.file_id) {
      message.video.file = await this.getTelegramFile(message.video.file_id);
      const thumb = message.video?.thumb || message.video?.thumbnail;
      if (thumb) {
        message.video.thumb.file = await this.getTelegramFile(thumb.file_id);
      }
    }
    if (message.audio?.file_id) {
      message.audio.file = await this.getTelegramFile(message.audio.file_id);
    }
    if (Array.isArray(message.photo)) {
      message.photo = await Promise.all(message.photo.map(async (photo) => {
        if (photo.file_size > 0 && photo.file_id) {
          const file = await this.getTelegramFile(photo.file_id);
          return {
            ...photo,
            file: file,
          };
        }
        return photo;
      }));
    }
    if (message.video_note) {
      message.video_note.file = await this.getTelegramFile(message.video_note.file_id);
      const thumb = message.video_note?.thumb || message.video_note?.thumbnail;
      if (thumb) {
        message.video_note.thumb.file = await this.getTelegramFile(thumb.file_id);
      }
    }
    return message;
  }
  /**
   * @param {string} fileId - file id
   * @returns {Promise<{url: string, file_path: string}>}
   */
  async getTelegramFile(fileId) {
    const fileInfo = await this.bot.getFile(fileId);
    return {
      file_path: fileInfo.file_path,
      url: `https://${TELEGRAM_HOST}/file/bot${this.bot.token}/${fileInfo.file_path}`,
    }
  }
  /**
   * @description webhook telegram message - extend default telegram request message
   * @param {Request} request
   * @param {Response} response
   * @returns {Promise<void>}
   */
  async api(request, response) {
    try {
      const { message, type } = getMessageFromBody(
        request.body
      );
      this.bot.processUpdate({
        ...request.body,
        message: {
          ...message,
          type,
        }
      });
      response.sendStatus(200);
    } catch (error) {
      console.error(error.stack);
      response.sendStatus(error?.response?.statusCode ?? 400);
    }
  };
}

module.exports = (args) => new TelegramBotController(args);
