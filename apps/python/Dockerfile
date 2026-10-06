FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY speed_guard.py ./
ENTRYPOINT ["python", "-u", "speed_guard.py"]
