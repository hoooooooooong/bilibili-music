import os
import re
import subprocess

from config import AUDIO_BITRATE, AUDIO_SAMPLE_RATE


class ConvertError(Exception):
    pass


class AudioConverter:
    def to_mp3(self, input_path: str, output_path: str, cover_path: str = None,
               title: str = None, artist: str = None) -> str:
        """
        Convert input file to MP3 using ffmpeg.

        Args:
            input_path: Path to input audio/video file
            output_path: Path for output MP3 file
            cover_path: Optional path to cover image for embedding
            title: Optional track title for ID3 metadata
            artist: Optional artist name for ID3 metadata

        Returns:
            Absolute path of the output MP3 file

        Raises:
            ConvertError: On conversion failure
        """
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        cmd = ["ffmpeg", "-i", input_path]

        if cover_path and os.path.exists(cover_path):
            cmd += ["-i", cover_path]
            cmd += ["-map", "0:a", "-map", "1:0", "-c:v", "copy",
                    "-id3v2_version", "3",
                    "-metadata:s:v", "title=Album cover",
                    "-metadata:s:v", "comment=Cover (front)"]
        else:
            cmd += ["-vn"]

        cmd += [
            "-ab", AUDIO_BITRATE,
            "-ar", str(AUDIO_SAMPLE_RATE),
            "-ac", "2",
        ]

        if title:
            cmd += ["-metadata", f"title={title}"]
        if artist:
            cmd += ["-metadata", f"artist={artist}"]

        cmd += ["-y", output_path]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode != 0:
                raise ConvertError(f"ffmpeg 转换失败: {result.stderr[-500:]}")
            return os.path.abspath(output_path)
        except FileNotFoundError:
            raise ConvertError("未找到 ffmpeg，请安装并添加到 PATH")
        except subprocess.TimeoutExpired:
            raise ConvertError("音频转换超时（超过 5 分钟）")

    @staticmethod
    def check_ffmpeg() -> bool:
        """Check if ffmpeg is available on the system."""
        try:
            result = subprocess.run(
                ["ffmpeg", "-version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    @staticmethod
    def sanitize_filename(filename: str) -> str:
        """Remove invalid characters from filename."""
        return re.sub(r'[\\/:*?"<>|]', "_", filename)
