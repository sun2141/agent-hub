#!/usr/bin/env python3
"""
Telegram Design Handler
Telegram 봇과 Design Agent를 연결하는 핸들러

PM2로 실행:
  pm2 start telegram_design_handler.py --name design-bot --interpreter python3
"""

import os
import asyncio
import logging
from typing import Optional
from telegram import Update, Bot
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters
)

# 로컬 모듈
from design_agent import DesignAgent

# 로깅 설정
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)


class TelegramDesignHandler:
    """Telegram과 Design Agent 연결"""

    def __init__(self):
        self.bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
        self.chat_id = os.environ.get("TELEGRAM_CHAT_ID")
        self.project_path = os.environ.get("PALMONI_PATH", "/home/sun/workspace/palmoni")

        if not self.bot_token:
            raise ValueError("TELEGRAM_BOT_TOKEN 환경변수가 필요합니다")

        self.agent = DesignAgent(self.project_path)
        self.bot = Bot(token=self.bot_token)

    async def send_message(self, text: str, chat_id: str = None):
        """메시지 전송"""
        target_chat = chat_id or self.chat_id
        if not target_chat:
            logger.error("chat_id가 없습니다")
            return

        # 메시지 길이 제한 (4096자)
        if len(text) > 4000:
            text = text[:4000] + "\n\n... (메시지 잘림)"

        await self.bot.send_message(chat_id=target_chat, text=text)

    async def handle_design_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /design 명령어 처리

        /design <설명> - 디자인 요청
        /design status - 상태 확인
        /design approve - 승인
        /design reject [이유] - 거절
        /design preview <컴포넌트> - 미리보기
        /design commit - 커밋
        """
        if not context.args:
            await update.message.reply_text(
                "📐 디자인 에이전트 사용법\n\n"
                "/design <설명> - 디자인 개선 요청\n"
                "/design status - 현재 상태\n"
                "/design approve - 변경사항 승인\n"
                "/design reject [이유] - 거절\n"
                "/design preview <컴포넌트> - 분석\n"
                "/design commit - 적용\n\n"
                "예시:\n"
                "/design 로그인 버튼 더 둥글게 만들어줘"
            )
            return

        subcommand = context.args[0].lower()
        args_rest = " ".join(context.args[1:])

        # status
        if subcommand == "status":
            result = self.agent.get_status()
            await update.message.reply_text(result["message"])
            return

        # approve
        if subcommand == "approve":
            request_id = args_rest if args_rest else None
            result = self.agent.approve_request(request_id)
            await update.message.reply_text(result.get("message", str(result)))
            return

        # reject
        if subcommand == "reject":
            result = self.agent.reject_request(reason=args_rest)
            await update.message.reply_text(result.get("message", str(result)))
            return

        # preview
        if subcommand == "preview":
            if not args_rest:
                await update.message.reply_text("사용법: /design preview <컴포넌트명>")
                return
            result = self.agent.preview_component(args_rest)
            if result["success"]:
                msg = f"🔍 {result['component']} 분석 결과\n\n"
                for f in result["files"]:
                    msg += f"📄 {f['file']}\n"
                    if f["type"] == "css":
                        msg += f"  • 색상: {', '.join(f['colors_used'][:5])}\n"
                        msg += f"  • border-radius: {', '.join(f['border_radius'][:3])}\n"
                    msg += f"  • {f['line_count']}줄\n\n"
                await update.message.reply_text(msg)
            else:
                await update.message.reply_text(f"❌ {result['error']}")
            return

        # commit
        if subcommand == "commit":
            request_id = args_rest if args_rest else None
            result = self.agent.commit_changes(request_id)
            await update.message.reply_text(result.get("message", str(result)))
            return

        # 그 외는 디자인 요청으로 처리
        description = " ".join(context.args)
        await update.message.reply_text(f"🔄 분석 중: {description}")

        result = self.agent.process_request(description)

        if result["success"]:
            await update.message.reply_text(result["message"])
        else:
            error_msg = f"❌ {result.get('error', '알 수 없는 오류')}"
            if result.get("suggestion"):
                error_msg += f"\n\n💡 {result['suggestion']}"
            await update.message.reply_text(error_msg)

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """일반 메시지 처리 (디자인 관련 키워드 감지)"""
        text = update.message.text.lower()

        design_keywords = ["디자인", "스타일", "색상", "버튼", "폰트", "레이아웃"]

        if any(kw in text for kw in design_keywords):
            await update.message.reply_text(
                "💡 디자인 관련 요청이신가요?\n\n"
                "/design <요청내용> 형식으로 보내주세요.\n\n"
                "예: /design 로그인 버튼 색상을 파란색으로 변경"
            )

    def run(self):
        """봇 실행"""
        application = Application.builder().token(self.bot_token).build()

        # 핸들러 등록
        application.add_handler(CommandHandler("design", self.handle_design_command))
        application.add_handler(MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            self.handle_message
        ))

        # 시작 메시지
        logger.info("Design Bot 시작됨")

        # 봇 실행
        application.run_polling(allowed_updates=Update.ALL_TYPES)


def main():
    """진입점"""
    handler = TelegramDesignHandler()
    handler.run()


if __name__ == "__main__":
    main()
