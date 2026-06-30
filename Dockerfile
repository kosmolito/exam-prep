FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY app ./

RUN pip install -r requirements.txt --no-cache-dir


EXPOSE 8080

ENTRYPOINT ["python3", "serve.py", "--no-browser"]
